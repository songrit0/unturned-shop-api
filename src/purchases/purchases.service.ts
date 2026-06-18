import {
  ConflictException,
  ForbiddenException,
  Injectable,
  InternalServerErrorException,
  NotFoundException,
} from '@nestjs/common';
import { randomInt } from 'crypto';
import * as mysql from 'mysql2/promise';
import { DbService } from '../database/db.service';
import { Paginated, normalizePage } from '../common/pagination';
import { ClaimAllResult, PurchaseFilter, PurchaseItemRow, PurchaseRow, PurchaseView } from './purchases.types';

// A-Z + 2-9, excluding the visually ambiguous I, O, 0, 1.
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const CODE_LENGTH = 12;
const CODE_INSERT_RETRIES = 5;
/** Max purchases claimed per claim-all call — caps the FOR UPDATE lock footprint. */
const CLAIM_ALL_MAX = 200;

@Injectable()
export class PurchasesService {
  constructor(private readonly db: DbService) {}

  private purchasesTbl()     { return this.db.table('sv', 'p2p_purchases'); }
  private purchaseItemsTbl() { return this.db.table('sv', 'p2p_purchase_items'); }
  private itemsTbl()       { return this.db.table('sv', 'items'); }
  private itemTypesTbl()   { return this.db.table('sv', 'item_types'); }
  private codesTbl()       { return this.db.table('rc', 'codes'); }
  private codeItemsTbl()   { return this.db.table('rc', 'code_items'); }
  private codeOwnersTbl()  { return this.db.table('sv', 'code_owners'); }

  private viewSelectSql(extraWhere: string): string {
    return `SELECT p.id, p.buyer_steam, p.listing_id, p.item_id, p.amount, p.quality, p.state, p.rot,
                   p.purchased_at, p.claimed_at, p.redeem_code, p.is_bundle,
                   i.name AS item_name, i.image_url, i.type_id, t.name AS type_name
            FROM ${this.purchasesTbl()} p
            LEFT JOIN ${this.itemsTbl()} i ON i.id = p.item_id
            LEFT JOIN ${this.itemTypesTbl()} t ON t.id = i.type_id
            ${extraWhere}`;
  }

  /** Attach `bundleItems` to every row whose `is_bundle` is true, batched (no N+1). */
  private async attachBundleItems(rows: PurchaseView[]): Promise<PurchaseView[]> {
    const bundleIds = rows.filter((r) => Number(r.is_bundle) === 1).map((r) => r.id);
    if (bundleIds.length === 0) return rows;
    const children = await this.db.query<PurchaseItemRow>(
      `SELECT * FROM ${this.purchaseItemsTbl()} WHERE purchase_id IN (${bundleIds.map(() => '?').join(',')})`,
      bundleIds,
    );
    const byPurchase = new Map<number, PurchaseItemRow[]>();
    for (const c of children) {
      const arr = byPurchase.get(Number(c.purchase_id)) ?? [];
      arr.push(c);
      byPurchase.set(Number(c.purchase_id), arr);
    }
    for (const r of rows) {
      if (Number(r.is_bundle) === 1) r.bundleItems = byPurchase.get(r.id) ?? [];
    }
    return rows;
  }

  async listMine(buyerSteam: string, filter: PurchaseFilter, page?: number, limit?: number): Promise<Paginated<PurchaseView>> {
    const np = normalizePage(page, limit);
    const where: string[] = ['p.buyer_steam = ?'];
    const params: any[] = [buyerSteam];
    if (filter === 'unclaimed')      where.push('p.claimed_at IS NULL');
    else if (filter === 'claimed')   where.push('p.claimed_at IS NOT NULL');
    const whereSql = where.join(' AND ');

    const cnt = await this.db.first<{ c: number }>(
      `SELECT COUNT(*) AS c FROM ${this.purchasesTbl()} p WHERE ${whereSql}`,
      params,
    );
    const total = cnt ? Number(cnt.c) : 0;

    const rows = await this.db.query<PurchaseView>(
      this.viewSelectSql(`WHERE ${whereSql} ORDER BY p.purchased_at DESC LIMIT ? OFFSET ?`),
      [...params, np.limit, np.offset],
    );
    await this.attachBundleItems(rows);
    return { items: rows, total, page: np.page, limit: np.limit, pages: Math.ceil(total / np.limit) };
  }

  async getById(id: number): Promise<PurchaseView> {
    const row = await this.db.first<PurchaseView>(this.viewSelectSql(`WHERE p.id = ?`), [id]);
    if (!row) throw new NotFoundException('Purchase not found');
    await this.attachBundleItems([row]);
    return row;
  }

  /**
   * The unclaimed purchase a buyer obtained from a given listing. A listing sells exactly once
   * (status flips to 'sold' atomically in buyListing), so there is at most one such row.
   * Used by the P2P buy-and-claim flow to locate the purchase to mint a code for.
   */
  async findUnclaimedByListing(listingId: number, buyerSteam: string): Promise<PurchaseRow | null> {
    return this.db.first<PurchaseRow>(
      `SELECT * FROM ${this.purchasesTbl()}
        WHERE listing_id = ? AND buyer_steam = ? AND claimed_at IS NULL
        ORDER BY id DESC LIMIT 1`,
      [listingId, buyerSteam],
    );
  }

  /**
   * Mint a redeem code for an unclaimed purchase owned by the caller.
   * Atomic across: claim purchase row, insert rc_codes (with collision retry),
   * insert rc_code_items, insert sv_code_owners, stamp purchase with code/timestamp.
   */
  async claim(purchaseId: number, callerSteam: string): Promise<PurchaseView> {
    const conn = await this.db.getConnection();
    try {
      await conn.beginTransaction();
      const [rows] = await conn.query<mysql.RowDataPacket[]>(
        `SELECT * FROM ${this.purchasesTbl()} WHERE id = ? FOR UPDATE`, [purchaseId],
      );
      const p = rows[0] as PurchaseRow | undefined;
      if (!p) { await conn.rollback(); throw new NotFoundException('Purchase not found'); }
      if (String(p.buyer_steam) !== String(callerSteam)) {
        await conn.rollback();
        throw new ForbiddenException('not_buyer');
      }
      if (p.claimed_at != null) {
        await conn.rollback();
        throw new ConflictException('already_claimed');
      }

      const { code, codeId } = await this.insertNewCode(conn);
      if (Number(p.is_bundle) === 1) {
        const [children] = await conn.query<mysql.RowDataPacket[]>(
          `SELECT * FROM ${this.purchaseItemsTbl()} WHERE purchase_id = ?`, [p.id],
        );
        for (const child of children as unknown as PurchaseItemRow[]) {
          await conn.query(
            `INSERT INTO ${this.codeItemsTbl()} (code_id, item_id, amount, quality, state, rot)
             VALUES (?, ?, ?, ?, ?, 0)`,
            [codeId, child.item_id, child.amount, child.quality, child.state],
          );
        }
      } else {
        await conn.query(
          `INSERT INTO ${this.codeItemsTbl()} (code_id, item_id, amount, quality, state, rot)
           VALUES (?, ?, ?, ?, ?, ?)`,
          [codeId, p.item_id, p.amount, p.quality, p.state, p.rot],
        );
      }
      await conn.query(
        `INSERT INTO ${this.codeOwnersTbl()} (code_id, steam_id) VALUES (?, ?)`,
        [codeId, callerSteam],
      );
      await conn.query(
        `UPDATE ${this.purchasesTbl()} SET redeem_code = ?, claimed_at = NOW() WHERE id = ?`,
        [code, purchaseId],
      );
      await conn.commit();
    } catch (e) {
      try { await conn.rollback(); } catch { /* ignore */ }
      throw e;
    } finally {
      conn.release();
    }
    return this.getById(purchaseId);
  }

  /**
   * Claim every unclaimed purchase owned by the caller (optionally narrowed to `ids`)
   * into ONE shared redeem code. Atomic: a single rc_codes row, one sv_code_owners row,
   * one rc_code_items row per purchase, and the same code/timestamp stamped on each
   * purchase — all in one transaction (rolled back together on any error).
   *
   * Purchases that aren't the caller's or are already claimed are simply not selected
   * (filtered by buyer_steam + claimed_at IS NULL), so they're skipped without error.
   * When nothing is claimable, returns { code: null, count: 0, items: [] } and mints no code.
   */
  async claimAll(callerSteam: string, ids?: number[]): Promise<ClaimAllResult> {
    const conn = await this.db.getConnection();
    try {
      await conn.beginTransaction();

      const where: string[] = ['buyer_steam = ?', 'claimed_at IS NULL'];
      const params: any[] = [callerSteam];
      if (ids && ids.length > 0) {
        where.push(`id IN (${ids.map(() => '?').join(',')})`);
        params.push(...ids);
      }
      const [rows] = await conn.query<mysql.RowDataPacket[]>(
        `SELECT * FROM ${this.purchasesTbl()}
         WHERE ${where.join(' AND ')}
         ORDER BY purchased_at ASC
         LIMIT ${CLAIM_ALL_MAX}
         FOR UPDATE`,
        params,
      );
      const purchases = rows as PurchaseRow[];

      if (purchases.length === 0) {
        await conn.commit();
        return { redeem_code: null, count: 0, items: [] };
      }

      const { code, codeId } = await this.insertNewCode(conn);
      await conn.query(
        `INSERT INTO ${this.codeOwnersTbl()} (code_id, steam_id) VALUES (?, ?)`,
        [codeId, callerSteam],
      );
      for (const p of purchases) {
        if (Number(p.is_bundle) === 1) {
          const [children] = await conn.query<mysql.RowDataPacket[]>(
            `SELECT * FROM ${this.purchaseItemsTbl()} WHERE purchase_id = ?`, [p.id],
          );
          for (const child of children as unknown as PurchaseItemRow[]) {
            await conn.query(
              `INSERT INTO ${this.codeItemsTbl()} (code_id, item_id, amount, quality, state, rot)
               VALUES (?, ?, ?, ?, ?, 0)`,
              [codeId, child.item_id, child.amount, child.quality, child.state],
            );
          }
        } else {
          await conn.query(
            `INSERT INTO ${this.codeItemsTbl()} (code_id, item_id, amount, quality, state, rot)
             VALUES (?, ?, ?, ?, ?, ?)`,
            [codeId, p.item_id, p.amount, p.quality, p.state, p.rot],
          );
        }
        await conn.query(
          `UPDATE ${this.purchasesTbl()} SET redeem_code = ?, claimed_at = NOW() WHERE id = ?`,
          [code, p.id],
        );
      }
      await conn.commit();

      // Hydrate item names for the response (read-only, outside the txn).
      const claimedIds = purchases.map((p) => p.id);
      const views = await this.db.query<PurchaseView>(
        this.viewSelectSql(`WHERE p.id IN (${claimedIds.map(() => '?').join(',')})`),
        claimedIds,
      );
      const items = views.map((v) => ({
        item_id: Number(v.item_id),
        item_name: v.item_name ?? '',
        amount: Number(v.amount),
        quality: Number(v.quality),
      }));
      return { redeem_code: code, count: purchases.length, items };
    } catch (e) {
      try { await conn.rollback(); } catch { /* ignore */ }
      throw e;
    } finally {
      conn.release();
    }
  }

  private generateCode(): string {
    let out = '';
    for (let i = 0; i < CODE_LENGTH; i++) {
      out += CODE_ALPHABET[randomInt(CODE_ALPHABET.length)];
    }
    return out;
  }

  /**
   * Mint a fresh single-use rc_codes row on the given connection, retrying on code collisions.
   * Shared by the purchase-claim flows (no expiry) and the P2P refund flow (expiry in days).
   * @param expiresInDays when > 0, sets expires_at = NOW() + N days (MySQL clock); otherwise NULL (never expires).
   */
  async insertNewCode(
    conn: mysql.PoolConnection,
    expiresInDays?: number,
  ): Promise<{ code: string; codeId: number }> {
    const withExpiry = typeof expiresInDays === 'number' && expiresInDays > 0;
    for (let attempt = 0; attempt < CODE_INSERT_RETRIES; attempt++) {
      const code = this.generateCode();
      try {
        const [res] = await conn.query<mysql.ResultSetHeader>(
          withExpiry
            ? `INSERT INTO ${this.codesTbl()} (code, max_uses, expires_at)
               VALUES (?, 1, DATE_ADD(NOW(), INTERVAL ? DAY))`
            : `INSERT INTO ${this.codesTbl()} (code, max_uses) VALUES (?, 1)`,
          withExpiry ? [code, Math.floor(expiresInDays as number)] : [code],
        );
        return { code, codeId: Number(res.insertId) };
      } catch (e: any) {
        if (e?.code === 'ER_DUP_ENTRY') continue;
        throw e;
      }
    }
    throw new InternalServerErrorException('code_collision_retry_exhausted');
  }
}
