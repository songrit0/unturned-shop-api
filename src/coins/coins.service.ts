import {
  BadRequestException,
  HttpException,
  HttpStatus,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as mysql from 'mysql2/promise';
import { DbService } from '../database/db.service';
import { UsersService } from '../users/users.service';
import { Paginated, normalizePage } from '../common/pagination';

export interface MarketLogRow {
  id: number; item_id: number; amount: number; coins: number;
  kind: 'buy' | 'sell' | string; at: Date; name?: string;
}
export interface ActivityLogRow { id: number; kind: string; coins: number; at: Date; }
export interface CoinStats { window_days: number; net_change: number; credits: number; debits: number; }

/** One normalized row of the unified Coin transaction-history timeline. */
export interface HistoryRow {
  at: string;                                                  // ISO timestamp
  source: 'shop' | 'p2p' | 'admin' | 'tax' | 'transfer';
  direction: 'in' | 'out';
  coins: number;                                               // SIGNED: + for in, - for out
  label: string;
  item_id: number | null;
  item_name: string | null;
  amount: number | null;
  counterparty: string | null;
}

/** Recipient resolution result for a transfer. */
export interface TransferTarget {
  steam_id: string;
  discord_id: string | null;
  name: string;
}

@Injectable()
export class CoinsService {
  private readonly log = new Logger(CoinsService.name);

  constructor(
    private readonly db: DbService,
    private readonly cfg: ConfigService,
    private readonly users: UsersService,
  ) {}

  // ---- config ---------------------------------------------------------------

  /** Flat fee burned on every transfer (sender pays amount + fee). */
  transferFee(): number {
    const v = Number(this.cfg.get<number>('coin.transferFee') ?? 200);
    return Number.isFinite(v) && v >= 0 ? Math.floor(v) : 200;
  }

  /** Minimum transfer amount (must exceed the fee). */
  transferMin(): number {
    const v = Number(this.cfg.get<number>('coin.transferMin') ?? 201);
    return Number.isFinite(v) && v >= 1 ? Math.floor(v) : 201;
  }

  transferConfig(): { transfer_fee: number; transfer_min: number } {
    return { transfer_fee: this.transferFee(), transfer_min: this.transferMin() };
  }

  /** P2P commission percent — same source the p2p service reads. Used to reconstruct historical seller proceeds. */
  private p2pCommissionPct(): number {
    const v = Number(this.cfg.get<number>('p2p.commissionPercent') ?? 5);
    if (!Number.isFinite(v) || v < 0) return 0;
    return Math.min(100, v);
  }

  async getBalance(steamId: string | null): Promise<number> {
    if (!steamId) return 0;
    const coins = this.db.table('sv', 'coins');
    const row = await this.db.first<{ balance: number }>(
      `SELECT balance FROM ${coins} WHERE steam_id = ? LIMIT 1`, [steamId],
    );
    return row ? Number(row.balance) : 0;
  }

  async marketHistory(steamId: string | null, page?: number, limit?: number): Promise<Paginated<MarketLogRow>> {
    const np = normalizePage(page, limit);
    if (!steamId) return { items: [], total: 0, page: np.page, limit: np.limit, pages: 0 };
    const log = this.db.table('sv', 'market_log');
    const itemsT = this.db.table('sv', 'items');

    const cnt = await this.db.first<{ c: number }>(
      `SELECT COUNT(*) AS c FROM ${log} WHERE steam_id = ?`, [steamId],
    );
    const total = cnt ? Number(cnt.c) : 0;
    const items = await this.db.query<MarketLogRow>(
      `SELECT l.id, l.item_id, l.amount, l.coins, l.kind, l.at, i.name
       FROM ${log} l LEFT JOIN ${itemsT} i ON i.id = l.item_id
       WHERE l.steam_id = ? ORDER BY l.id DESC LIMIT ? OFFSET ?`,
      [steamId, np.limit, np.offset],
    );
    return { items, total, page: np.page, limit: np.limit, pages: Math.ceil(total / np.limit) };
  }

  async stats(steamId: string | null, windowDays = 7): Promise<CoinStats> {
    const empty: CoinStats = { window_days: windowDays, net_change: 0, credits: 0, debits: 0 };
    if (!steamId) return empty;
    const marketLog = this.db.table('sv', 'market_log');
    const activityLog = this.db.table('sv', 'activity_log');
    try {
      const row = await this.db.first<{ credits: number | null; debits: number | null; net: number | null }>(
        `SELECT
           COALESCE(SUM(CASE WHEN coins > 0 THEN coins ELSE 0 END), 0) AS credits,
           COALESCE(SUM(CASE WHEN coins < 0 THEN coins ELSE 0 END), 0) AS debits,
           COALESCE(SUM(coins), 0) AS net
         FROM (
           SELECT coins FROM ${marketLog} WHERE steam_id = ? AND at >= NOW() - INTERVAL ? DAY
           UNION ALL
           SELECT coins FROM ${activityLog} WHERE steam_id = ? AND at >= NOW() - INTERVAL ? DAY
         ) AS combined`,
        [steamId, windowDays, steamId, windowDays],
      );
      if (!row) return empty;
      return {
        window_days: windowDays,
        net_change: Number(row.net ?? 0),
        credits: Number(row.credits ?? 0),
        debits: Number(row.debits ?? 0),
      };
    } catch {
      return empty;
    }
  }

  async activityHistory(steamId: string | null, page?: number, limit?: number): Promise<Paginated<ActivityLogRow>> {
    const np = normalizePage(page, limit);
    if (!steamId) return { items: [], total: 0, page: np.page, limit: np.limit, pages: 0 };
    const log = this.db.table('sv', 'activity_log');
    try {
      const cnt = await this.db.first<{ c: number }>(
        `SELECT COUNT(*) AS c FROM ${log} WHERE steam_id = ?`, [steamId],
      );
      const total = cnt ? Number(cnt.c) : 0;
      const items = await this.db.query<ActivityLogRow>(
        `SELECT id, kind, coins, at FROM ${log}
         WHERE steam_id = ? ORDER BY id DESC LIMIT ? OFFSET ?`,
        [steamId, np.limit, np.offset],
      );
      return { items, total, page: np.page, limit: np.limit, pages: Math.ceil(total / np.limit) };
    } catch {
      return { items: [], total: 0, page: np.page, limit: np.limit, pages: 0 };
    }
  }

  // ---- unified history ------------------------------------------------------

  /**
   * Normalized, paginated, newest-first timeline for a steam_id merging the four Coin
   * sources (shop buy/sell, p2p buy/sell, admin/tax, transfers) via a single UNION ALL.
   * Each branch normalizes to the SAME column list so the outer query can ORDER BY at DESC
   * and LIMIT/OFFSET across all sources; a second matching UNION drives the COUNT total.
   *
   * Sign/source conventions (see report):
   *  - shop: sv_market_log.coins is a POSITIVE magnitude; sign is derived from `kind`
   *    (buy -> out/negative, sell -> in/positive).
   *  - p2p: from sv_p2p_listings status='sold'. Buyer -> -price (out). Seller -> +(price -
   *    ROUND(price*COMM/100)) where COMM is the CURRENT p2p.commissionPercent.
   *  - activity: sv_activity_log.coins is already signed (grant +, take -); tax kinds map to
   *    source 'tax', everything else to 'admin'.
   *  - transfer: sender -> -(amount + fee) (out), recipient -> +amount (in).
   */
  async unifiedHistory(steamId: string | null, page?: number, limit?: number): Promise<Paginated<HistoryRow>> {
    const np = normalizePage(page, limit);
    if (!steamId) return { items: [], total: 0, page: np.page, limit: np.limit, pages: 0 };

    const marketLog = this.db.table('sv', 'market_log');
    const p2p = this.db.table('sv', 'p2p_listings');
    const activity = this.db.table('sv', 'activity_log');
    const transfers = this.db.table('sv', 'coin_transfers');
    const items = this.db.table('sv', 'items');
    const links = this.db.table('sv', 'links');

    const comm = this.p2pCommissionPct();
    // Player display name from sv_links: prefer global name, then username, then raw steam id.
    const nameExpr = (alias: string) =>
      `COALESCE(${alias}.discord_global_name, ${alias}.discord_username, ${alias}.steam_id)`;

    // UNION ALL of the four normalized sources. Param order is preserved across count + page queries.
    const unionSql = `
      SELECT
        ml.at                                          AS at,
        'shop'                                         AS source,
        CASE WHEN ml.kind = 'buy' THEN 'out' ELSE 'in' END AS direction,
        CASE WHEN ml.kind = 'buy' THEN -ABS(ml.coins) ELSE ABS(ml.coins) END AS coins,
        ml.kind                                        AS label,
        ml.item_id                                     AS item_id,
        mi.name                                        AS item_name,
        ml.amount                                      AS amount,
        NULL                                           AS counterparty
      FROM ${marketLog} ml
      LEFT JOIN ${items} mi ON mi.id = ml.item_id
      WHERE ml.steam_id = ?

      UNION ALL

      SELECT
        pl.closed_at                                   AS at,
        'p2p'                                          AS source,
        CASE WHEN pl.buyer_steam = ? THEN 'out' ELSE 'in' END AS direction,
        CASE WHEN pl.buyer_steam = ?
             THEN -ROUND(pl.price)
             ELSE (ROUND(pl.price) - ROUND(pl.price * ? / 100)) END AS coins,
        CASE WHEN pl.buyer_steam = ? THEN 'p2p_buy' ELSE 'p2p_sell' END AS label,
        pl.item_id                                     AS item_id,
        pi.name                                        AS item_name,
        pl.amount                                      AS amount,
        CASE WHEN pl.buyer_steam = ? THEN ${nameExpr('psl')} ELSE ${nameExpr('pbl')} END AS counterparty
      FROM ${p2p} pl
      LEFT JOIN ${items} pi ON pi.id = pl.item_id
      LEFT JOIN ${links} psl ON psl.steam_id = pl.seller_steam
      LEFT JOIN ${links} pbl ON pbl.steam_id = pl.buyer_steam
      WHERE pl.status = 'sold' AND (pl.seller_steam = ? OR pl.buyer_steam = ?)

      UNION ALL

      SELECT
        al.at                                          AS at,
        CASE WHEN al.kind LIKE 'tax%' THEN 'tax' ELSE 'admin' END AS source,
        CASE WHEN al.coins < 0 THEN 'out' ELSE 'in' END AS direction,
        al.coins                                       AS coins,
        al.kind                                        AS label,
        NULL                                           AS item_id,
        NULL                                           AS item_name,
        NULL                                           AS amount,
        NULL                                           AS counterparty
      FROM ${activity} al
      WHERE al.steam_id = ?

      UNION ALL

      SELECT
        ct.created_at                                  AS at,
        'transfer'                                     AS source,
        CASE WHEN ct.sender_steam = ? THEN 'out' ELSE 'in' END AS direction,
        CASE WHEN ct.sender_steam = ? THEN -(ct.amount + ct.fee) ELSE ct.amount END AS coins,
        CASE WHEN ct.sender_steam = ? THEN 'transfer_out' ELSE 'transfer_in' END AS label,
        NULL                                           AS item_id,
        NULL                                           AS item_name,
        ct.amount                                      AS amount,
        CASE WHEN ct.sender_steam = ? THEN ${nameExpr('trl')} ELSE ${nameExpr('tsl')} END AS counterparty
      FROM ${transfers} ct
      LEFT JOIN ${links} tsl ON tsl.steam_id = ct.sender_steam
      LEFT JOIN ${links} trl ON trl.steam_id = ct.recipient_steam
      WHERE ct.sender_steam = ? OR ct.recipient_steam = ?
    `;

    // Param list mirrors the placeholder order above, top-to-bottom.
    const unionParams: any[] = [
      steamId,                                  // shop steam_id
      steamId, steamId, comm, steamId, steamId, // p2p: direction, coins(x2 via buyer check + comm), label, counterparty-branch
      steamId, steamId,                         // p2p WHERE seller OR buyer
      steamId,                                  // activity steam_id
      steamId, steamId, steamId, steamId,       // transfer: direction, coins, label, counterparty-branch
      steamId, steamId,                         // transfer WHERE sender OR recipient
    ];

    try {
      const cntRow = await this.db.first<{ c: number }>(
        `SELECT COUNT(*) AS c FROM (${unionSql}) AS unified`,
        unionParams,
      );
      const total = cntRow ? Number(cntRow.c) : 0;

      const rows = await this.db.query<any>(
        // Format `at` as a literal UTC ISO string. The source DATETIMEs are stored UTC, but mysql2's
        // default timezone:'local' returns them as JS Dates in the host zone, so new Date(at)/.toISOString()
        // would shift by the host offset. ORDER BY still uses the raw `at` (correct ordering).
        `SELECT unified.*, DATE_FORMAT(unified.at, '%Y-%m-%dT%H:%i:%sZ') AS at_iso
         FROM (${unionSql}) AS unified ORDER BY at DESC LIMIT ? OFFSET ?`,
        [...unionParams, np.limit, np.offset],
      );

      const items_out: HistoryRow[] = rows.map((r) => ({
        at: r.at_iso ?? '',
        source: r.source,
        direction: r.direction,
        coins: Number(r.coins),
        label: String(r.label),
        item_id: r.item_id != null ? Number(r.item_id) : null,
        item_name: r.item_name ?? null,
        amount: r.amount != null ? Number(r.amount) : null,
        counterparty: r.counterparty != null ? String(r.counterparty) : null,
      }));

      return { items: items_out, total, page: np.page, limit: np.limit, pages: Math.ceil(total / np.limit) };
    } catch (e: any) {
      this.log.warn(`unifiedHistory failed for ${steamId}: ${e.message}`);
      return { items: [], total: 0, page: np.page, limit: np.limit, pages: 0 };
    }
  }

  // ---- transfer -------------------------------------------------------------

  /** Display name for a player: discord global/username, else "Steam …last4". */
  private async displayNameForSteam(steamId: string, discordId: string | null): Promise<string> {
    const links = this.db.table('sv', 'links');
    const row = await this.db.first<{ discord_global_name: string | null; discord_username: string | null }>(
      `SELECT discord_global_name, discord_username FROM ${links} WHERE steam_id = ? LIMIT 1`,
      [steamId],
    );
    const name = row?.discord_global_name || row?.discord_username;
    if (name) return name;
    return `Steam …${steamId.slice(-4)}`;
  }

  /**
   * Resolve a transfer recipient by Steam ID or Discord ID. `callerSteam`, when provided,
   * is used to reject self-transfers (throws `cannot_transfer_self`). Throws `target_not_found`
   * when the target can't be resolved to a known player.
   */
  async lookupRecipient(
    targetType: 'steam' | 'discord',
    targetId: string,
    callerSteam?: string | null,
  ): Promise<TransferTarget> {
    const id = (targetId ?? '').trim();
    if (!id) throw new NotFoundException('target_not_found');

    let steamId: string | null = null;
    if (targetType === 'discord') {
      steamId = await this.users.findSteamByDiscord(id);
      if (!steamId) throw new NotFoundException('target_not_found');
    } else {
      // steam: verify it is a KNOWN player (has an sv_links row OR an sv_coins row).
      const links = this.db.table('sv', 'links');
      const coins = this.db.table('sv', 'coins');
      const known = await this.db.first<{ c: number }>(
        `SELECT
           (SELECT COUNT(*) FROM ${links} WHERE steam_id = ?) +
           (SELECT COUNT(*) FROM ${coins} WHERE steam_id = ?) AS c`,
        [id, id],
      );
      if (!known || Number(known.c) === 0) throw new NotFoundException('target_not_found');
      steamId = id;
    }

    if (callerSteam && steamId === callerSteam) {
      throw new BadRequestException('cannot_transfer_self');
    }

    const discordId = await this.users.findDiscordBySteam(steamId);
    const name = await this.displayNameForSteam(steamId, discordId);
    return { steam_id: steamId, discord_id: discordId, name };
  }

  /**
   * Atomic player-to-player Coin transfer. Sender pays amount + flat fee; recipient receives
   * the full amount; the fee is burned (a sink). Returns the sender's new balance.
   * Recipient is resolved via lookupRecipient (Steam ID or Discord ID).
   */
  async transfer(
    senderSteam: string,
    targetType: 'steam' | 'discord',
    targetId: string,
    amount: number,
  ): Promise<{ balance: number }> {
    const fee = this.transferFee();
    const min = this.transferMin();

    if (!Number.isInteger(amount) || amount < min) {
      throw new BadRequestException('amount_too_low');
    }

    // Resolve recipient (throws target_not_found / cannot_transfer_self).
    const target = await this.lookupRecipient(targetType, targetId, senderSteam);
    const recipientSteam = target.steam_id;

    const coins = this.db.table('sv', 'coins');
    const transfers = this.db.table('sv', 'coin_transfers');
    const total = amount + fee;

    let newBalance = 0;
    const conn = await this.db.getConnection();
    try {
      await conn.beginTransaction();
      try {
        // Debit sender total (atomic guard: only succeeds if balance >= total).
        const [debit] = await conn.query<mysql.ResultSetHeader>(
          `UPDATE ${coins} SET balance = balance - ? WHERE steam_id = ? AND balance >= ?`,
          [total, senderSteam, total],
        );
        if (debit.affectedRows === 0) {
          await conn.rollback();
          throw new HttpException('insufficient_funds', HttpStatus.PAYMENT_REQUIRED);
        }

        // Credit recipient the full amount (upsert: row may not exist yet).
        await conn.query(
          `INSERT INTO ${coins} (steam_id, balance) VALUES (?, ?)
           ON DUPLICATE KEY UPDATE balance = balance + VALUES(balance)`,
          [recipientSteam, amount],
        );

        // Record the transfer (fee burned — not credited anywhere).
        await conn.query(
          `INSERT INTO ${transfers} (sender_steam, recipient_steam, amount, fee) VALUES (?, ?, ?, ?)`,
          [senderSteam, recipientSteam, amount, fee],
        );

        // Read back the sender's new balance inside the txn.
        const [balRows] = await conn.query<mysql.RowDataPacket[]>(
          `SELECT balance FROM ${coins} WHERE steam_id = ? LIMIT 1`,
          [senderSteam],
        );
        newBalance = balRows[0] ? Number(balRows[0].balance) : 0;

        await conn.commit();
      } catch (e) {
        try { await conn.rollback(); } catch { /* ignore */ }
        throw e;
      }
    } finally {
      conn.release();
    }

    // Best-effort recipient notification (never fails the committed transfer).
    if (target.discord_id) {
      try {
        const notifications = this.db.table('sv', 'notifications');
        const senderName = await this.displayNameForSteam(senderSteam, await this.users.findDiscordBySteam(senderSteam));
        const payload = {
          sender_steam: senderSteam,
          sender_name: senderName,
          amount,
          fee,
          at: new Date().toISOString(),
        };
        await this.db.query(
          `INSERT INTO ${notifications} (discord_id, steam_id, kind, payload) VALUES (?, ?, ?, ?)`,
          [target.discord_id, recipientSteam, 'coin_transfer_received', JSON.stringify(payload)],
        );
      } catch (e: any) {
        this.log.warn(`transfer notification failed (recipient ${recipientSteam}): ${e.message}`);
      }
    }

    return { balance: newBalance };
  }
}
