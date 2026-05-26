import { Injectable } from '@nestjs/common';
import { DbService } from '../database/db.service';

export interface MarketLogRow {
  id: number; item_id: number; amount: number; coins: number;
  kind: 'buy' | 'sell' | string; at: Date; name?: string;
}
export interface ActivityLogRow { id: number; kind: string; coins: number; at: Date; }
export interface Paginated<T> { items: T[]; total: number; page: number; limit: number; pages: number; }

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

  private normPage(page: any, limit: any): { page: number; limit: number; offset: number } {
    const p = Math.max(1, parseInt(page, 10) || 1);
    const l = Math.min(100, Math.max(1, parseInt(limit, 10) || 20));
    return { page: p, limit: l, offset: (p - 1) * l };
  }

  async marketHistory(steamId: string | null, page = 1, limit = 20): Promise<Paginated<MarketLogRow>> {
    const np = this.normPage(page, limit);
    if (!steamId) return { items: [], total: 0, page: np.page, limit: np.limit, pages: 0 };
    const log = this.db.table('sv', 'market_log');
    const market = this.db.table('sv', 'market');

    const cnt = await this.db.first<{ c: number }>(
      `SELECT COUNT(*) AS c FROM ${log} WHERE steam_id = ?`, [steamId],
    );
    const total = cnt ? Number(cnt.c) : 0;
    const items = await this.db.query<MarketLogRow>(
      `SELECT l.id, l.item_id, l.amount, l.coins, l.kind, l.at, m.name
       FROM ${log} l LEFT JOIN ${market} m ON m.item_id = l.item_id
       WHERE l.steam_id = ? ORDER BY l.id DESC LIMIT ? OFFSET ?`,
      [steamId, np.limit, np.offset],
    );
    return { items, total, page: np.page, limit: np.limit, pages: Math.ceil(total / np.limit) };
  }

  async activityHistory(steamId: string | null, page = 1, limit = 20): Promise<Paginated<ActivityLogRow>> {
    const np = this.normPage(page, limit);
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
