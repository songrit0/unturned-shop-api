import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  HttpException,
  HttpStatus,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as mysql from 'mysql2/promise';
import { DbService } from '../database/db.service';
import { VaultsService } from '../vaults/vaults.service';
import { VaultItem } from '../vaults/vaults.types';
import { PurchasesService } from '../purchases/purchases.service';
import { Paginated, normalizePage } from '../common/pagination';
import {
  CreateListingInput,
  ListingsFilter,
  P2PAction,
  P2PListingRow,
  P2PListingView,
} from './p2p.types';

@Injectable()
export class P2pService {
  private readonly log = new Logger(P2pService.name);

  constructor(
    private readonly db: DbService,
    private readonly vaults: VaultsService,
    private readonly cfg: ConfigService,
    private readonly purchases: PurchasesService,
  ) {}

  private listingsTbl() { return this.db.table('sv', 'p2p_listings'); }
  private logTbl()      { return this.db.table('sv', 'p2p_log'); }
  private linksTbl()    { return this.db.table('sv', 'links'); }
  private coinsTbl()    { return this.db.table('sv', 'coins'); }
  private itemsTbl()    { return this.db.table('sv', 'items'); }
  private itemTypesTbl(){ return this.db.table('sv', 'item_types'); }

  /** Commission percent applied to the buyer's payment; seller receives (1 - pct/100) * price. */
  private commissionPct(): number {
    const v = Number(this.cfg.get<number>('p2p.commissionPercent') ?? 5);
    if (!Number.isFinite(v) || v < 0) return 0;
    return Math.min(100, v);
  }

  async listActive(filters: ListingsFilter): Promise<Paginated<P2PListingView>> {
    const np = normalizePage(filters.page, filters.limit);
    const where: string[] = [];
    const params: any[] = [];

    const status = filters.status || 'active';
    where.push('l.status = ?'); params.push(status);
    if (filters.item_id  != null) { where.push('l.item_id = ?');   params.push(filters.item_id); }
    if (filters.type_id  != null) { where.push('i.type_id = ?');   params.push(filters.type_id); }
    if (filters.seller)           { where.push('l.seller_steam = ?'); params.push(filters.seller); }
    if (filters.min_price != null){ where.push('l.price >= ?');    params.push(filters.min_price); }
    if (filters.max_price != null){ where.push('l.price <= ?');    params.push(filters.max_price); }
    const whereSql = where.length ? where.join(' AND ') : '1=1';

    const cntRow = await this.db.first<{ c: number }>(
      `SELECT COUNT(*) AS c FROM ${this.listingsTbl()} l
       LEFT JOIN ${this.itemsTbl()} i ON i.id = l.item_id
       WHERE ${whereSql}`,
      params,
    );
    const total = cntRow ? Number(cntRow.c) : 0;

    const rows = await this.db.query<P2PListingView>(
      `SELECT l.*, i.name AS item_name, i.image_url, i.type_id, t.name AS type_name,
              COALESCE(ls.discord_username, ls.discord_global_name, ls.discord_id) AS seller_discord_name,
              COALESCE(lb.discord_username, lb.discord_global_name, lb.discord_id) AS buyer_discord_name
       FROM ${this.listingsTbl()} l
       LEFT JOIN ${this.itemsTbl()} i ON i.id = l.item_id
       LEFT JOIN ${this.itemTypesTbl()} t ON t.id = i.type_id
       LEFT JOIN ${this.linksTbl()} ls ON ls.steam_id = l.seller_steam
       LEFT JOIN ${this.linksTbl()} lb ON lb.steam_id = l.buyer_steam
       WHERE ${whereSql}
       ORDER BY l.created_at DESC
       LIMIT ? OFFSET ?`,
      [...params, np.limit, np.offset],
    );
    return { items: rows, total, page: np.page, limit: np.limit, pages: Math.ceil(total / np.limit) };
  }

  async getListing(id: number): Promise<P2PListingView> {
    const row = await this.db.first<P2PListingView>(
      `SELECT l.*, i.name AS item_name, i.image_url, i.type_id, t.name AS type_name,
              COALESCE(ls.discord_username, ls.discord_global_name, ls.discord_id) AS seller_discord_name,
              COALESCE(lb.discord_username, lb.discord_global_name, lb.discord_id) AS buyer_discord_name
       FROM ${this.listingsTbl()} l
       LEFT JOIN ${this.itemsTbl()} i ON i.id = l.item_id
       LEFT JOIN ${this.itemTypesTbl()} t ON t.id = i.type_id
       LEFT JOIN ${this.linksTbl()} ls ON ls.steam_id = l.seller_steam
       LEFT JOIN ${this.linksTbl()} lb ON lb.steam_id = l.buyer_steam
       WHERE l.id = ?`,
      [id],
    );
    if (!row) throw new NotFoundException('Listing not found');
    return row;
  }

  async listingsForSeller(steamId: string, page?: number, limit?: number): Promise<Paginated<P2PListingView>> {
    const np = normalizePage(page, limit);
    const cntRow = await this.db.first<{ c: number }>(
      `SELECT COUNT(*) AS c FROM ${this.listingsTbl()} WHERE seller_steam = ?`, [steamId],
    );
    const total = cntRow ? Number(cntRow.c) : 0;
    const rows = await this.db.query<P2PListingView>(
      `SELECT l.*, i.name AS item_name, i.image_url, i.type_id, t.name AS type_name,
              COALESCE(ls.discord_username, ls.discord_global_name, ls.discord_id) AS seller_discord_name,
              COALESCE(lb.discord_username, lb.discord_global_name, lb.discord_id) AS buyer_discord_name
       FROM ${this.listingsTbl()} l
       LEFT JOIN ${this.itemsTbl()} i ON i.id = l.item_id
       LEFT JOIN ${this.itemTypesTbl()} t ON t.id = i.type_id
       LEFT JOIN ${this.linksTbl()} ls ON ls.steam_id = l.seller_steam
       LEFT JOIN ${this.linksTbl()} lb ON lb.steam_id = l.buyer_steam
       WHERE l.seller_steam = ?
       ORDER BY l.created_at DESC
       LIMIT ? OFFSET ?`,
      [steamId, np.limit, np.offset],
    );
    return { items: rows, total, page: np.page, limit: np.limit, pages: Math.ceil(total / np.limit) };
  }

  /**
   * Pull `itemIndex` out of seller's vault, persist as an active listing.
   * Holds VaultsLocks for the seller's vault for the duration of the transaction.
   */
  async createListing(sellerSteam: string, input: CreateListingInput): Promise<P2PListingView> {
    if (!Number.isFinite(input.price) || input.price <= 0) {
      throw new BadRequestException('price must be > 0');
    }
    const conn = await this.db.getConnection();
    let listingId: number;
    try {
      await this.vaults.acquireLock(conn, sellerSteam, input.vaultName);
      try {
        await conn.beginTransaction();

        const [vrows] = await conn.query<mysql.RowDataPacket[]>(
          `SELECT Data FROM ${this.vaults.vaultsTbl()} WHERE OwnerId = ? AND Name = ? FOR UPDATE`,
          [sellerSteam, input.vaultName],
        );
        if (vrows.length === 0) {
          await conn.rollback();
          throw new NotFoundException('Vault not found');
        }
        const items = this.vaults.parseVaultData((vrows[0] as any).Data);
        if (input.itemIndex < 0 || input.itemIndex >= items.length) {
          await conn.rollback();
          throw new BadRequestException('itemIndex out of range');
        }
        const picked: VaultItem = items[input.itemIndex];
        const next = items.slice(0, input.itemIndex).concat(items.slice(input.itemIndex + 1));
        await conn.query(
          `UPDATE ${this.vaults.vaultsTbl()} SET Data = ?, LastUpdate = NOW() WHERE OwnerId = ? AND Name = ?`,
          [this.vaults.serializeVaultData(next), sellerSteam, input.vaultName],
        );

        const [ins] = await conn.query<mysql.ResultSetHeader>(
          `INSERT INTO ${this.listingsTbl()}
             (seller_steam, item_id, amount, quality, rot, state, price, status)
           VALUES (?, ?, ?, ?, ?, ?, ?, 'active')`,
          [sellerSteam, picked.Id, picked.Amount, picked.Quality, picked.Rot, picked.State, input.price],
        );
        listingId = Number(ins.insertId);
        await this.writeLog(conn, listingId, 'list', sellerSteam, { item_id: picked.Id, vault: input.vaultName });
        await conn.commit();
      } catch (e) {
        try { await conn.rollback(); } catch { /* ignore */ }
        throw e;
      } finally {
        await this.vaults.releaseLock(conn, sellerSteam, input.vaultName);
      }
    } finally {
      conn.release();
    }
    return this.getListing(listingId);
  }

  /**
   * Buyer purchases an active listing. Atomic across:
   * - Lock listing row (status check)
   * - Debit buyer's sv_coins (full price)
   * - Credit seller's sv_coins (price - commission)
   * - INSERT sv_p2p_purchases row (buyer claims later via /purchases/:id/claim)
   * - Mark listing sold
   */
  async buyListing(buyerSteam: string, listingId: number): Promise<P2PListingView> {
    const conn = await this.db.getConnection();
    try {
      // Pre-load listing for early rejection (final source of truth is the FOR UPDATE inside txn)
      const pre = await this.getListing(listingId);
      if (pre.seller_steam === buyerSteam) {
        throw new BadRequestException('cannot_buy_own_listing');
      }
      if (pre.status !== 'active') {
        throw new ConflictException('listing_no_longer_active');
      }

      await conn.beginTransaction();
      try {
        const [lrows] = await conn.query<mysql.RowDataPacket[]>(
          `SELECT * FROM ${this.listingsTbl()} WHERE id = ? FOR UPDATE`, [listingId],
        );
        const listing = (lrows[0] as P2PListingRow | undefined);
        if (!listing) { await conn.rollback(); throw new NotFoundException('Listing not found'); }
        if (listing.status !== 'active') {
          await conn.rollback();
          throw new ConflictException('listing_no_longer_active');
        }
        if (listing.seller_steam === buyerSteam) {
          await conn.rollback();
          throw new BadRequestException('cannot_buy_own_listing');
        }

        const price = Number(listing.price);
        const commission = Math.round((price * this.commissionPct() / 100));
        const sellerProceeds = Math.max(0, Math.round(price) - commission);

        // Debit buyer (atomic: UPDATE ... WHERE balance >= price)
        const [debit] = await conn.query<mysql.ResultSetHeader>(
          `UPDATE ${this.coinsTbl()} SET balance = balance - ? WHERE steam_id = ? AND balance >= ?`,
          [Math.round(price), buyerSteam, Math.round(price)],
        );
        if (debit.affectedRows === 0) {
          await conn.rollback();
          throw new HttpException('insufficient_funds', HttpStatus.PAYMENT_REQUIRED);
        }

        // Credit seller (upsert: row may not exist)
        await conn.query(
          `INSERT INTO ${this.coinsTbl()} (steam_id, balance) VALUES (?, ?)
           ON DUPLICATE KEY UPDATE balance = balance + VALUES(balance)`,
          [listing.seller_steam, sellerProceeds],
        );

        // Record the unclaimed purchase. The buyer redeems it later via /purchases/:id/claim
        // which mints the redeem code; we deliberately do not touch Vaults here.
        await conn.query(
          `INSERT INTO ${this.db.table('sv', 'p2p_purchases')}
             (buyer_steam, listing_id, item_id, amount, quality, state, rot)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
          [buyerSteam, listingId, listing.item_id, listing.amount, listing.quality, listing.state, listing.rot],
        );

        // Close listing
        await conn.query(
          `UPDATE ${this.listingsTbl()} SET status='sold', buyer_steam=?, closed_at=NOW() WHERE id = ?`,
          [buyerSteam, listingId],
        );
        await this.writeLog(conn, listingId, 'buy', buyerSteam, {
          price, commission, seller_proceeds: sellerProceeds, seller: listing.seller_steam,
        });

        await conn.commit();
      } catch (e) {
        try { await conn.rollback(); } catch { /* ignore */ }
        throw e;
      }
    } finally {
      conn.release();
    }
    return this.getListing(listingId);
  }

  /**
   * Buy a listing AND immediately mint the redeem code (instant delivery for the Discord
   * Buy button). Composes the existing buyListing + PurchasesService.claim — no duplicated
   * coin/code logic. The buy commits first; if the subsequent claim somehow fails, the buyer
   * still owns the (unclaimed) purchase and can claim it later via /purchases.
   */
  async buyAndClaim(
    buyerSteam: string,
    listingId: number,
  ): Promise<{ redeem_code: string | null; item_name: string | null; amount: number; price: number }> {
    const listing = await this.buyListing(buyerSteam, listingId);
    const purchase = await this.purchases.findUnclaimedByListing(listingId, buyerSteam);
    if (!purchase) {
      // buyListing succeeded but we can't locate the purchase to claim — should not happen.
      // Don't fail the buy (coins already moved); surface no code — buyer claims via /purchases.
      this.log.warn(`buyAndClaim(${listingId}): no unclaimed purchase found post-buy for ${buyerSteam}`);
      return { redeem_code: null, item_name: listing.item_name, amount: Number(listing.amount), price: Number(listing.price) };
    }
    const claimed = await this.purchases.claim(Number(purchase.id), buyerSteam);
    return {
      redeem_code: claimed.redeem_code,
      item_name: claimed.item_name ?? listing.item_name,
      amount: Number(claimed.amount),
      price: Number(listing.price),
    };
  }

  /** Seller cancels — held item is refunded as an expiring redeem code (not returned to vault). */
  async cancelListing(sellerSteam: string, listingId: number): Promise<P2PListingView> {
    return this.closeAndRefund(listingId, sellerSteam, 'cancel', sellerSteam);
  }

  /** Admin force-close — refund held item to seller as an expiring redeem code, log actor. */
  async adminForceClose(listingId: number, actor: string): Promise<P2PListingView> {
    return this.closeAndRefund(listingId, null, 'admin_force_close', actor);
  }

  /**
   * Shared close path. Instead of returning the held item to the seller's vault, this mints a
   * single-use refund redeem code (rc_codes + rc_code_items, owned by the seller via sv_code_owners)
   * with an expiry of P2P_REFUND_CODE_TTL_DAYS, then records a sv_notifications row so the web inbox
   * and the Discord bot can surface the code to the seller. All work happens in one transaction.
   * @param requireSellerMatch — if non-null, the caller must equal seller_steam (cancel flow).
   */
  private async closeAndRefund(
    listingId: number,
    requireSellerMatch: string | null,
    action: Extract<P2PAction, 'cancel' | 'admin_force_close' | 'expire'>,
    actor: string,
  ): Promise<P2PListingView> {
    const ttlDays = this.refundCodeTtlDays();
    const conn = await this.db.getConnection();
    // Captured inside the txn, used for the best-effort notification AFTER commit.
    let sellerSteam = '';
    let itemId = 0;
    let amount = 0;
    let quality = 0;
    let code = '';
    let codeExpiresAt: string | null = null;
    let codeExpiresAtUnix: number | null = null;
    try {
      await conn.beginTransaction();
      try {
        const [lrows] = await conn.query<mysql.RowDataPacket[]>(
          `SELECT * FROM ${this.listingsTbl()} WHERE id = ? FOR UPDATE`, [listingId],
        );
        const listing = lrows[0] as P2PListingRow | undefined;
        if (!listing) { await conn.rollback(); throw new NotFoundException('Listing not found'); }
        if (listing.status !== 'active') {
          await conn.rollback();
          throw new ConflictException('listing_no_longer_active');
        }
        if (requireSellerMatch && listing.seller_steam !== requireSellerMatch) {
          await conn.rollback();
          throw new ForbiddenException('not_listing_owner');
        }
        sellerSteam = listing.seller_steam;
        itemId = Number(listing.item_id);
        amount = Number(listing.amount);
        quality = Number(listing.quality);

        // 1) Mint a single-use refund code carrying the held item, expiring in ttlDays.
        const { code: minted, codeId } = await this.purchases.insertNewCode(conn, ttlDays);
        code = minted;
        await conn.query(
          `INSERT INTO ${this.db.table('rc', 'code_items')} (code_id, item_id, amount, quality, state, rot)
           VALUES (?, ?, ?, ?, ?, ?)`,
          [codeId, listing.item_id, listing.amount, listing.quality, listing.state, listing.rot],
        );
        await conn.query(
          `INSERT INTO ${this.db.table('sv', 'code_owners')} (code_id, steam_id) VALUES (?, ?)`,
          [codeId, listing.seller_steam],
        );
        // Read the code's expiry back from the MySQL clock for the listing row + notification payload.
        // Also fetch epoch seconds via UNIX_TIMESTAMP so the bot can render a TZ-unambiguous
        // Discord relative timestamp (the ISO string is for the web).
        const codeRow = await this.firstOnConn<{ expires_at: string | null; expires_at_unix: number | string | null }>(
          conn,
          `SELECT expires_at, UNIX_TIMESTAMP(expires_at) AS expires_at_unix
             FROM ${this.db.table('rc', 'codes')} WHERE id = ?`,
          [codeId],
        );
        codeExpiresAt = codeRow?.expires_at ?? null;
        codeExpiresAtUnix = codeRow?.expires_at_unix != null ? Number(codeRow.expires_at_unix) : null;

        // 2) Close the listing, stamping the minted code + its expiry directly on the row
        //    so my-listings can surface it without depending on the notification.
        const finalStatus = action === 'expire' ? 'expired' : 'cancelled';
        await conn.query(
          `UPDATE ${this.listingsTbl()}
              SET status=?, closed_at=NOW(), redeem_code=?, code_expires_at=?
            WHERE id = ?`,
          [finalStatus, code, codeExpiresAt, listingId],
        );
        await this.writeLog(conn, listingId, action, actor, { refund_code: code, code_expires_at: codeExpiresAt });

        // The atomic core (code mint + listing close + log) commits here. The notification
        // below is intentionally OUTSIDE this txn so a not-yet-applied 006 migration can't
        // break cancel/expire — the seller always has the code via /codes + the listing row.
        await conn.commit();
      } catch (e) {
        try { await conn.rollback(); } catch { /* ignore */ }
        throw e;
      }
    } finally {
      conn.release();
    }

    // 3) Best-effort notification (web inbox + bot DM source). Never throws into the close path:
    //    on any failure (missing sv_notifications table, unlinked seller, etc.) we log and move on.
    try {
      const itemMeta = await this.db.first<{ item_name: string | null; image_url: string | null }>(
        `SELECT name AS item_name, image_url FROM ${this.itemsTbl()} WHERE id = ?`,
        [itemId],
      );
      const link = await this.db.first<{ discord_id: string | null }>(
        `SELECT discord_id FROM ${this.linksTbl()} WHERE steam_id = ? LIMIT 1`,
        [sellerSteam],
      );
      const discordId = link?.discord_id ?? null;
      if (discordId == null) {
        this.log.warn(
          `closeAndRefund(${listingId}): seller ${sellerSteam} has no linked discord_id; minted code ${code} but skipped notification`,
        );
      } else {
        const payload = {
          listing_id: listingId,
          item_id: itemId,
          item_name: itemMeta?.item_name ?? null,
          image_url: itemMeta?.image_url ?? null,
          amount,
          quality,
          code,
          code_expires_at: codeExpiresAt,
          code_expires_at_unix: codeExpiresAtUnix,
        };
        await this.db.query(
          `INSERT INTO ${this.notificationsTbl()} (discord_id, steam_id, kind, payload)
           VALUES (?, ?, ?, ?)`,
          [discordId, sellerSteam, this.notificationKind(action), JSON.stringify(payload)],
        );
      }
    } catch (e: any) {
      this.log.warn(
        `closeAndRefund(${listingId}): notification insert failed (code ${code} minted + listing closed): ${e.message}`,
      );
    }

    return this.getListing(listingId);
  }

  private notificationsTbl() { return this.db.table('sv', 'notifications'); }

  /** TTL (days) for the refund redeem code minted on cancel/expire/force-close. */
  private refundCodeTtlDays(): number {
    const v = Number(this.cfg.get<number>('p2p.refundCodeTtlDays') ?? 7);
    return Number.isFinite(v) && v > 0 ? Math.floor(v) : 7;
  }

  private notificationKind(action: Extract<P2PAction, 'cancel' | 'admin_force_close' | 'expire'>): string {
    switch (action) {
      case 'expire': return 'p2p_expired';
      case 'admin_force_close': return 'p2p_force_closed';
      default: return 'p2p_cancelled';
    }
  }

  /** first() against an in-transaction connection (DbService.first uses the pool, not this conn). */
  private async firstOnConn<T = any>(
    conn: mysql.PoolConnection,
    sql: string,
    params?: any,
  ): Promise<T | null> {
    const [rows] = await conn.query<mysql.RowDataPacket[]>(sql, params);
    return (rows[0] as T) ?? null;
  }

  /** Find all active listings older than the TTL — used by the expire cron. */
  async findExpired(ttlDays: number, limit = 100): Promise<P2PListingRow[]> {
    return this.db.query<P2PListingRow>(
      `SELECT * FROM ${this.listingsTbl()}
       WHERE status='active' AND created_at < (NOW() - INTERVAL ? DAY)
       LIMIT ?`,
      [ttlDays, limit],
    );
  }

  /** Cron entry: expire one listing, refunding the held item as an expiring redeem code. */
  async expireOne(listingId: number): Promise<void> {
    try {
      await this.closeAndRefund(listingId, null, 'expire', 'cron');
    } catch (e: any) {
      this.log.warn(`expireOne(${listingId}) failed: ${e.message}`);
    }
  }

  private async writeLog(
    conn: mysql.PoolConnection,
    listingId: number,
    action: P2PAction,
    actor: string,
    meta: Record<string, unknown> | null,
  ): Promise<void> {
    await conn.query(
      `INSERT INTO ${this.logTbl()} (listing_id, action, actor, meta) VALUES (?, ?, ?, ?)`,
      [listingId, action, actor, meta ? JSON.stringify(meta) : null],
    );
  }
}
