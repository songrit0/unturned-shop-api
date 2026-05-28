import { Injectable } from '@nestjs/common';
import { DbService } from '../database/db.service';
import { Paginated, normalizePage } from '../common/pagination';

export interface MarketLogRow {
  id: number; item_id: number; amount: number; coins: number;
  kind: 'buy' | 'sell' | string; at: Date; name?: string;
}
export interface ActivityLogRow { id: number; kind: string; coins: number; at: Date; }
export interface CoinStats { window_days: number; net_change: number; credits: number; debits: number; }

@Injectable()
export class CoinsService {
  constructor(private readonly db: DbService) {}

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
}
