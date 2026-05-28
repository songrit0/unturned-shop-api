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
import { PurchaseFilter, PurchaseRow, PurchaseView } from './purchases.types';

// A-Z + 2-9, excluding the visually ambiguous I, O, 0, 1.
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const CODE_LENGTH = 12;
const CODE_INSERT_RETRIES = 5;

@Injectable()
export class PurchasesService {
  constructor(private readonly db: DbService) {}

  private purchasesTbl()   { return this.db.table('sv', 'p2p_purchases'); }
  private itemsTbl()       { return this.db.table('sv', 'items'); }
  private itemTypesTbl()   { return this.db.table('sv', 'item_types'); }
  private codesTbl()       { return this.db.table('rc', 'codes'); }
  private codeItemsTbl()   { return this.db.table('rc', 'code_items'); }
  private codeOwnersTbl()  { return this.db.table('sv', 'code_owners'); }

  private viewSelectSql(extraWhere: string): string {
    return `SELECT p.id, p.buyer_steam, p.listing_id, p.item_id, p.amount, p.quality, p.state, p.rot,
                   p.purchased_at, p.claimed_at, p.redeem_code,
                   i.name AS item_name, i.image_url, i.type_id, t.name AS type_name
            FROM ${this.purchasesTbl()} p
            LEFT JOIN ${this.itemsTbl()} i ON i.id = p.item_id
            LEFT JOIN ${this.itemTypesTbl()} t ON t.id = i.type_id
            ${extraWhere}`;
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
    return { items: rows, total, page: np.page, limit: np.limit, pages: Math.ceil(total / np.limit) };
  }

  async getById(id: number): Promise<PurchaseView> {
    const row = await this.db.first<PurchaseView>(this.viewSelectSql(`WHERE p.id = ?`), [id]);
    if (!row) throw new NotFoundException('Purchase not found');
    return row;
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
      await conn.query(
        `INSERT INTO ${this.codeItemsTbl()} (code_id, item_id, amount, quality, state, rot)
         VALUES (?, ?, ?, ?, ?, ?)`,
        [codeId, p.item_id, p.amount, p.quality, p.state, p.rot],
      );
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

  private generateCode(): string {
    let out = '';
    for (let i = 0; i < CODE_LENGTH; i++) {
      out += CODE_ALPHABET[randomInt(CODE_ALPHABET.length)];
    }
    return out;
  }

  private async insertNewCode(conn: mysql.PoolConnection): Promise<{ code: string; codeId: number }> {
    for (let attempt = 0; attempt < CODE_INSERT_RETRIES; attempt++) {
      const code = this.generateCode();
      try {
        const [res] = await conn.query<mysql.ResultSetHeader>(
          `INSERT INTO ${this.codesTbl()} (code, max_uses) VALUES (?, 1)`, [code],
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
