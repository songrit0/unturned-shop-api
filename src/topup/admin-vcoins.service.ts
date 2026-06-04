import { BadRequestException, Injectable } from '@nestjs/common';
import * as mysql from 'mysql2/promise';
import { DbService } from '../database/db.service';
import { Paginated, normalizePage } from '../common/pagination';
import { TopupDbService } from './topup-db.service';

export interface AdminTopupRow {
  id: number;
  ref: string;
  steam_id: string;
  discord_name: string | null;
  baht: string;
  unique_amount: string;
  vcoins: string;
  status: string;
  created_at: string;
  confirmed_at: string | null;
  credited_at: string | null;
}

export interface VcoinLogEntry {
  delta: number;
  reason: string;
  ref: string | null;
  actor: string | null;
  at: string;
}

export interface AdminWalletView {
  steam_id: string;
  discord_name: string | null;
  balance: number;
  log: VcoinLogEntry[];
}

@Injectable()
export class AdminVcoinsService {
  constructor(
    /** Pi5-local top-up DB — owns the wallet, log and top-up records. */
    private readonly topupDb: TopupDbService,
    /** External shop DB — READ-ONLY here, only to resolve the Discord display name from sv_links. */
    private readonly shopDb: DbService,
  ) {}

  private linksTbl() { return this.shopDb.table('sv', 'links'); }

  /**
   * Resolve Discord display names for a set of steam_ids from sv_links (external, read-only).
   * COALESCE(discord_username, discord_global_name, discord_id). Missing -> not in the map.
   */
  private async discordNamesFor(steamIds: string[]): Promise<Map<string, string | null>> {
    const out = new Map<string, string | null>();
    const ids = [...new Set(steamIds.filter(Boolean))];
    if (ids.length === 0) return out;
    const rows = await this.shopDb.query<{ steam_id: string; discord_name: string | null }>(
      `SELECT steam_id,
              COALESCE(discord_username, discord_global_name, discord_id) AS discord_name
       FROM ${this.linksTbl()}
       WHERE steam_id IN (${ids.map(() => '?').join(',')})`,
      ids,
    );
    for (const r of rows) out.set(String(r.steam_id), r.discord_name ?? null);
    return out;
  }

  private async discordNameFor(steamId: string): Promise<string | null> {
    const m = await this.discordNamesFor([steamId]);
    return m.get(steamId) ?? null;
  }

  /** GET /admin/vcoins/topups — all top-ups, newest first, with optional status + q filters. */
  async listTopups(
    status?: string,
    q?: string,
    page?: number,
    limit?: number,
  ): Promise<Paginated<AdminTopupRow>> {
    const np = normalizePage(page, limit);

    const where: string[] = [];
    const params: any[] = [];

    const VALID = ['pending', 'confirmed', 'credited', 'expired', 'cancelled', 'failed'];
    if (status && VALID.includes(status)) {
      where.push('status = ?');
      params.push(status);
    }
    // q matches steam_id OR the discord_id stamped on the row (the discord display name
    // lives in the external DB, so we pre-resolve matching steam_ids for name search too).
    let nameMatchedSteamIds: string[] = [];
    const term = q?.trim();
    if (term) {
      try {
        const links = await this.shopDb.query<{ steam_id: string }>(
          `SELECT steam_id FROM ${this.linksTbl()}
           WHERE discord_username LIKE ? OR discord_global_name LIKE ? OR discord_id LIKE ?
           LIMIT 500`,
          [`%${term}%`, `%${term}%`, `%${term}%`],
        );
        nameMatchedSteamIds = links.map((l) => String(l.steam_id));
      } catch {
        /* external DB unavailable -> fall back to steam_id-only match */
      }
      const ors = ['steam_id LIKE ?'];
      params.push(`%${term}%`);
      if (nameMatchedSteamIds.length > 0) {
        ors.push(`steam_id IN (${nameMatchedSteamIds.map(() => '?').join(',')})`);
        params.push(...nameMatchedSteamIds);
      }
      where.push(`(${ors.join(' OR ')})`);
    }
    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';

    const cnt = await this.topupDb.first<{ c: number }>(
      `SELECT COUNT(*) AS c FROM topups ${whereSql}`, params,
    );
    const total = cnt ? Number(cnt.c) : 0;

    const rows = await this.topupDb.query<Omit<AdminTopupRow, 'discord_name'> & { discord_id: string | null }>(
      `SELECT id, ref, steam_id, discord_id, baht, unique_amount, vcoins, status,
              created_at, confirmed_at, credited_at
       FROM topups ${whereSql}
       ORDER BY id DESC
       LIMIT ? OFFSET ?`,
      [...params, np.limit, np.offset],
    );

    const names = await this.discordNamesFor(rows.map((r) => String(r.steam_id)));
    const items: AdminTopupRow[] = rows.map((r) => ({
      id: Number(r.id),
      ref: r.ref,
      steam_id: String(r.steam_id),
      discord_name: names.get(String(r.steam_id)) ?? null,
      baht: r.baht,
      unique_amount: r.unique_amount,
      vcoins: r.vcoins,
      status: r.status,
      created_at: r.created_at,
      confirmed_at: r.confirmed_at,
      credited_at: r.credited_at,
    }));

    return { items, total, page: np.page, limit: np.limit, pages: Math.ceil(total / np.limit) };
  }

  /** GET /admin/vcoins/wallet/:steamId — balance + latest ~50 log rows. */
  async getWallet(steamId: string): Promise<AdminWalletView> {
    const balRow = await this.topupDb.first<{ balance: string }>(
      `SELECT balance FROM v_coins WHERE steam_id = ?`, [steamId],
    );
    const log = await this.topupDb.query<VcoinLogEntry>(
      `SELECT delta, reason, ref, actor, at
       FROM v_coin_log WHERE steam_id = ?
       ORDER BY id DESC LIMIT 50`,
      [steamId],
    );
    return {
      steam_id: steamId,
      discord_name: await this.discordNameFor(steamId),
      balance: balRow ? Number(balRow.balance) : 0,
      log: log.map((l) => ({ ...l, delta: Number(l.delta) })),
    };
  }

  /**
   * POST /admin/vcoins/adjust — balance += delta (may go negative; NO floor).
   * One Pi5 transaction; logs the delta with the admin's actor id.
   */
  async adjust(
    steamId: string,
    delta: number,
    actor: string,
    reason?: string,
  ): Promise<{ steam_id: string; balance: number }> {
    if (!Number.isFinite(delta) || delta === 0) {
      throw new BadRequestException('delta must be a non-zero number');
    }
    const d = Math.trunc(delta);
    const conn = await this.topupDb.getConnection();
    try {
      await conn.beginTransaction();
      await conn.query(
        `INSERT INTO v_coins (steam_id, balance) VALUES (?, ?)
         ON DUPLICATE KEY UPDATE balance = balance + VALUES(balance)`,
        [steamId, d],
      );
      await conn.query(
        `INSERT INTO v_coin_log (steam_id, delta, reason, ref, actor)
         VALUES (?, ?, COALESCE(?, 'admin_adjust'), NULL, ?)`,
        [steamId, d, reason?.trim() || null, actor],
      );
      const [rows] = await conn.query<mysql.RowDataPacket[]>(
        `SELECT balance FROM v_coins WHERE steam_id = ?`, [steamId],
      );
      await conn.commit();
      const balance = rows[0] ? Number((rows[0] as any).balance) : d;
      return { steam_id: steamId, balance };
    } catch (e) {
      try { await conn.rollback(); } catch { /* ignore */ }
      throw e;
    } finally {
      conn.release();
    }
  }

  /**
   * POST /admin/vcoins/set — set the absolute balance, logging the (new - old) delta.
   * One Pi5 transaction; logs with the admin's actor id.
   */
  async set(
    steamId: string,
    balance: number,
    actor: string,
    reason?: string,
  ): Promise<{ steam_id: string; balance: number }> {
    if (!Number.isFinite(balance)) {
      throw new BadRequestException('balance must be a finite number');
    }
    const target = Math.trunc(balance);
    const conn = await this.topupDb.getConnection();
    try {
      await conn.beginTransaction();
      // Lock (or create) the row, then compute the delta we are about to apply.
      await conn.query(
        `INSERT INTO v_coins (steam_id, balance) VALUES (?, 0)
         ON DUPLICATE KEY UPDATE balance = balance`,
        [steamId],
      );
      const [cur] = await conn.query<mysql.RowDataPacket[]>(
        `SELECT balance FROM v_coins WHERE steam_id = ? FOR UPDATE`, [steamId],
      );
      const old = cur[0] ? Number((cur[0] as any).balance) : 0;
      const delta = target - old;

      await conn.query(`UPDATE v_coins SET balance = ? WHERE steam_id = ?`, [target, steamId]);
      if (delta !== 0) {
        await conn.query(
          `INSERT INTO v_coin_log (steam_id, delta, reason, ref, actor)
           VALUES (?, ?, COALESCE(?, 'admin_set'), NULL, ?)`,
          [steamId, delta, reason?.trim() || null, actor],
        );
      }
      await conn.commit();
      return { steam_id: steamId, balance: target };
    } catch (e) {
      try { await conn.rollback(); } catch { /* ignore */ }
      throw e;
    } finally {
      conn.release();
    }
  }
}
