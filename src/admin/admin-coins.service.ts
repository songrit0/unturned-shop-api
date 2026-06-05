import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { DbService } from '../database/db.service';
import { Paginated, normalizePage } from '../common/pagination';
import { CoinsService, HistoryRow } from '../coins/coins.service';

export interface CoinUserRow {
  steam_id: string;
  balance: number;
  discord_id: string | null;
  linked_at: string | null;
}

@Injectable()
export class AdminCoinsService {
  constructor(private readonly db: DbService, private readonly coins: CoinsService) {}

  /** List all coin holders (paginated). */
  async listUsers(page?: number, limit?: number, search = ''): Promise<Paginated<CoinUserRow>> {
    const coins = this.db.table('sv', 'coins');
    const links = this.db.table('sv', 'links');
    const np = normalizePage(page, limit);

    const where: string[] = [];
    const params: any[] = [];
    if (search?.trim()) {
      where.push(`(c.steam_id LIKE ? OR l.discord_id LIKE ?)`);
      params.push(`%${search.trim()}%`, `%${search.trim()}%`);
    }
    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';

    const cntRow = await this.db.first<{ c: number }>(
      `SELECT COUNT(*) AS c FROM ${coins} c LEFT JOIN ${links} l ON l.steam_id = c.steam_id ${whereSql}`,
      params,
    );
    const total = cntRow ? Number(cntRow.c) : 0;

    const items = await this.db.query<CoinUserRow>(
      `SELECT c.steam_id, c.balance, l.discord_id, l.linked_at
       FROM ${coins} c LEFT JOIN ${links} l ON l.steam_id = c.steam_id
       ${whereSql}
       ORDER BY c.balance DESC
       LIMIT ? OFFSET ?`,
      [...params, np.limit, np.offset],
    );

    return { items, total, page: np.page, limit: np.limit, pages: Math.ceil(total / np.limit) };
  }

  async getOne(steamId: string): Promise<CoinUserRow> {
    const coins = this.db.table('sv', 'coins');
    const links = this.db.table('sv', 'links');
    const row = await this.db.first<CoinUserRow>(
      `SELECT c.steam_id, c.balance, l.discord_id, l.linked_at
       FROM ${coins} c LEFT JOIN ${links} l ON l.steam_id = c.steam_id
       WHERE c.steam_id = ? LIMIT 1`,
      [steamId],
    );
    if (!row) throw new NotFoundException('User not found');
    return row;
  }

  /** Grant or deduct coins; positive = grant, negative = take. Returns new balance. */
  async adjust(steamId: string, delta: number, adminDiscordId: string, reason: string): Promise<{ steam_id: string; balance: number }> {
    if (!Number.isFinite(delta) || delta === 0) throw new BadRequestException('delta must be non-zero');

    const coins = this.db.table('sv', 'coins');
    const activity = this.db.table('sv', 'activity_log');
    const conn = await this.db.getConnection();
    try {
      await conn.beginTransaction();

      // ensure row exists
      await conn.query(
        `INSERT INTO ${coins} (steam_id, balance) VALUES (?, 0) ON DUPLICATE KEY UPDATE balance = balance`,
        [steamId],
      );
      // lock row
      const [rows] = await conn.query(`SELECT balance FROM ${coins} WHERE steam_id = ? FOR UPDATE`, [steamId]);
      const current = (rows as any[])[0] ? Number((rows as any[])[0].balance) : 0;

      if (delta < 0 && current + delta < 0) {
        // cap negative — don't go below 0
        delta = -current;
      }

      if (delta !== 0) {
        await conn.query(`UPDATE ${coins} SET balance = balance + ? WHERE steam_id = ?`, [delta, steamId]);
        const kind = delta > 0 ? `admin_grant:${adminDiscordId}` : `admin_take:${adminDiscordId}`;
        await conn.query(
          `INSERT INTO ${activity} (steam_id, kind, coins) VALUES (?, ?, ?)`,
          [steamId, (reason ? `${kind}:${reason.slice(0, 80)}` : kind).slice(0, 24), delta],
        );
      }

      await conn.commit();
      return { steam_id: steamId, balance: current + delta };
    } catch (e) {
      try { await conn.rollback(); } catch {}
      throw e;
    } finally {
      conn.release();
    }
  }

  async historyForUser(steamId: string, page?: number, limit?: number): Promise<Paginated<{ id: number; kind: string; coins: number; at: Date }>> {
    const np = normalizePage(page, limit);
    const log = this.db.table('sv', 'activity_log');

    const cnt = await this.db.first<{ c: number }>(
      `SELECT COUNT(*) AS c FROM ${log} WHERE steam_id = ?`,
      [steamId],
    );
    const total = cnt ? Number(cnt.c) : 0;

    const items = await this.db.query<{ id: number; kind: string; coins: number; at: Date }>(
      `SELECT id, kind, coins, at FROM ${log} WHERE steam_id = ? ORDER BY id DESC LIMIT ? OFFSET ?`,
      [steamId, np.limit, np.offset],
    );
    return { items, total, page: np.page, limit: np.limit, pages: Math.ceil(total / np.limit) };
  }

  /** Unified Coin transaction-history timeline for a target steam_id (shop + p2p + admin/tax + transfers). */
  async unifiedHistoryForUser(steamId: string, page?: number, limit?: number): Promise<Paginated<HistoryRow>> {
    return this.coins.unifiedHistory(steamId, page, limit);
  }
}
