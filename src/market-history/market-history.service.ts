import { Injectable, Logger } from '@nestjs/common';
import { DbService } from '../database/db.service';

export type CandleInterval = '1m' | '5m' | '15m' | '1h' | '4h' | '1d';

const INTERVAL_SECONDS: Record<CandleInterval, number> = {
  '1m': 60,
  '5m': 300,
  '15m': 900,
  '1h': 3600,
  '4h': 14400,
  '1d': 86400,
};

export interface Candle {
  time: number;     // unix seconds, bucket start
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;   // sum of amount from market_log in bucket
  stock: number;    // last amount snapshot in bucket
}

export interface Forecast {
  current_price: number;
  ma_7d: number | null;
  ma_30d: number | null;
  projected_price: number;
  trend: 'up' | 'down' | 'stable';
  base_price: number;
  target_stock: number;
  elasticity: number;
  current_stock: number;
}

export interface TransactionRow {
  at: Date;
  steam_id: string;
  discord_id: string | null;
  item_id: number;
  item_name: string | null;
  kind: string;
  amount: number;
  coins: number;
  price_per_unit: number;
}

export interface Paginated<T> {
  items: T[];
  total: number;
  page: number;
  limit: number;
  pages: number;
}

@Injectable()
export class MarketHistoryService {
  private readonly log = new Logger(MarketHistoryService.name);

  constructor(private readonly db: DbService) {}

  /** Batch-insert one row per item into market_price_history. Caller wraps in try/catch. */
  async snapshotAll(): Promise<number> {
    const market = this.db.table('sv', 'market');
    const history = this.db.table('sv', 'market_price_history');
    const rows = await this.db.query<{ item_id: number; price: number; amount: number }>(
      `SELECT item_id, price, amount FROM ${market}`,
    );
    if (rows.length === 0) return 0;
    const now = new Date();
    const placeholders = rows.map(() => '(?, ?, ?, ?)').join(',');
    const params: any[] = [];
    for (const r of rows) {
      params.push(Number(r.item_id), Number(r.price), Number(r.amount), now);
    }
    await this.db.query(
      `INSERT INTO ${history} (item_id, price, amount, snapshot_at) VALUES ${placeholders}`,
      params,
    );
    return rows.length;
  }

  /** Delete rows older than 30 days. Returns affected rows. */
  async cleanup(): Promise<number> {
    const history = this.db.table('sv', 'market_price_history');
    const result: any = await this.db.query(
      `DELETE FROM ${history} WHERE snapshot_at < NOW() - INTERVAL 30 DAY`,
    );
    return Number(result?.affectedRows || 0);
  }

  async candles(itemId: number, interval: CandleInterval, from: Date, to: Date): Promise<Candle[]> {
    const history = this.db.table('sv', 'market_price_history');
    const log = this.db.table('sv', 'market_log');
    const sec = INTERVAL_SECONDS[interval];

    // Bucket = floor(unix_ts / sec) * sec, computed in SQL.
    // OHLC: open = price at MIN(snapshot_at); close = price at MAX(snapshot_at).
    // SUBSTRING_INDEX(GROUP_CONCAT(... ORDER BY ...)) gives us first/last per bucket without correlated subqueries — Pi5-friendly.
    const buckets = await this.db.query<{
      bucket: number; open: number; close: number; high: number; low: number; stock: number;
    }>(
      `SELECT
         FLOOR(UNIX_TIMESTAMP(snapshot_at) / ?) * ? AS bucket,
         CAST(SUBSTRING_INDEX(GROUP_CONCAT(price ORDER BY snapshot_at ASC), ',', 1) AS DOUBLE) AS open,
         CAST(SUBSTRING_INDEX(GROUP_CONCAT(price ORDER BY snapshot_at DESC), ',', 1) AS DOUBLE) AS close,
         MAX(price) AS high,
         MIN(price) AS low,
         CAST(SUBSTRING_INDEX(GROUP_CONCAT(amount ORDER BY snapshot_at DESC), ',', 1) AS SIGNED) AS stock
       FROM ${history}
       WHERE item_id = ? AND snapshot_at >= ? AND snapshot_at < ?
       GROUP BY bucket
       ORDER BY bucket ASC`,
      [sec, sec, itemId, from, to],
    );

    if (buckets.length === 0) return [];

    const volumes = await this.db.query<{ bucket: number; volume: number }>(
      `SELECT FLOOR(UNIX_TIMESTAMP(at) / ?) * ? AS bucket, SUM(amount) AS volume
       FROM ${log}
       WHERE item_id = ? AND at >= ? AND at < ? AND kind IN ('buy','sell')
       GROUP BY bucket`,
      [sec, sec, itemId, from, to],
    );
    const volByBucket = new Map<number, number>();
    for (const v of volumes) volByBucket.set(Number(v.bucket), Number(v.volume));

    return buckets.map((b) => ({
      time: Number(b.bucket),
      open: Number(b.open),
      high: Number(b.high),
      low: Number(b.low),
      close: Number(b.close),
      volume: volByBucket.get(Number(b.bucket)) || 0,
      stock: Number(b.stock),
    }));
  }

  async forecast(itemId: number): Promise<Forecast | null> {
    const market = this.db.table('sv', 'market');
    const history = this.db.table('sv', 'market_price_history');

    const mkt = await this.db.first<{
      price: number; base_price: number; target_stock: number; elasticity: number; amount: number;
    }>(
      `SELECT price, base_price, target_stock, elasticity, amount
       FROM ${market} WHERE item_id = ?`,
      [itemId],
    );
    if (!mkt) return null;

    const ma7 = await this.db.first<{ ma: number | null }>(
      `SELECT AVG(price) AS ma FROM ${history}
       WHERE item_id = ? AND snapshot_at > NOW() - INTERVAL 7 DAY`,
      [itemId],
    );
    const ma30 = await this.db.first<{ ma: number | null }>(
      `SELECT AVG(price) AS ma FROM ${history}
       WHERE item_id = ? AND snapshot_at > NOW() - INTERVAL 30 DAY`,
      [itemId],
    );

    const ma7v = ma7?.ma != null ? Number(ma7.ma) : null;
    const ma30v = ma30?.ma != null ? Number(ma30.ma) : null;

    const base = Number(mkt.base_price);
    const tgt = Math.max(1, Number(mkt.target_stock));
    const cur = Math.max(1, Number(mkt.amount));
    const e = Math.max(0, Math.min(Number(mkt.elasticity) ?? 0.5, 2));
    const projected = Math.round(base * Math.pow(tgt / cur, e));

    let trend: 'up' | 'down' | 'stable' = 'stable';
    if (ma7v != null && ma30v != null && ma30v > 0) {
      const diff = (ma7v - ma30v) / ma30v;
      if (diff > 0.02) trend = 'up';
      else if (diff < -0.02) trend = 'down';
    }

    return {
      current_price: Math.round(Number(mkt.price)),
      ma_7d: ma7v != null ? Math.round(ma7v) : null,
      ma_30d: ma30v != null ? Math.round(ma30v) : null,
      projected_price: projected,
      trend,
      base_price: base,
      target_stock: Number(mkt.target_stock),
      elasticity: Number(mkt.elasticity),
      current_stock: Number(mkt.amount),
    };
  }

  async transactionsForItem(itemId: number, page: number, limit: number): Promise<Paginated<TransactionRow>> {
    const np = this.normPage(page, limit);
    const log = this.db.table('sv', 'market_log');
    const links = this.db.table('sv', 'links');
    const items = this.db.table('sv', 'items');

    const cnt = await this.db.first<{ c: number }>(
      `SELECT COUNT(*) AS c FROM ${log} WHERE item_id = ?`, [itemId],
    );
    const total = cnt ? Number(cnt.c) : 0;

    const rows = await this.db.query<any>(
      `SELECT l.at, l.steam_id, l.item_id, l.amount, l.coins, l.kind,
              i.name AS item_name, lk.discord_id
       FROM ${log} l
       LEFT JOIN ${items} i ON i.id = l.item_id
       LEFT JOIN ${links} lk ON lk.steam_id = l.steam_id
       WHERE l.item_id = ?
       ORDER BY l.id DESC LIMIT ? OFFSET ?`,
      [itemId, np.limit, np.offset],
    );

    const items_out: TransactionRow[] = rows.map((r) => ({
      at: r.at,
      steam_id: String(r.steam_id),
      discord_id: r.discord_id != null ? String(r.discord_id) : null,
      item_id: Number(r.item_id),
      item_name: r.item_name ?? null,
      kind: String(r.kind),
      amount: Number(r.amount),
      coins: Number(r.coins),
      price_per_unit: Number(r.amount) > 0 ? Math.round(Number(r.coins) / Number(r.amount)) : 0,
    }));

    return { items: items_out, total, page: np.page, limit: np.limit, pages: Math.ceil(total / np.limit) };
  }

  async transactionsGlobal(page: number, limit: number, kind: 'buy' | 'sell' | 'all'): Promise<Paginated<TransactionRow>> {
    const np = this.normPage(page, limit);
    const log = this.db.table('sv', 'market_log');
    const links = this.db.table('sv', 'links');
    const items = this.db.table('sv', 'items');

    const where: string[] = [];
    const params: any[] = [];
    if (kind === 'buy' || kind === 'sell') {
      where.push('l.kind = ?');
      params.push(kind);
    }
    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';

    const cnt = await this.db.first<{ c: number }>(
      `SELECT COUNT(*) AS c FROM ${log} l ${whereSql}`, params,
    );
    const total = cnt ? Number(cnt.c) : 0;

    const rows = await this.db.query<any>(
      `SELECT l.at, l.steam_id, l.item_id, l.amount, l.coins, l.kind,
              i.name AS item_name, lk.discord_id
       FROM ${log} l
       LEFT JOIN ${items} i ON i.id = l.item_id
       LEFT JOIN ${links} lk ON lk.steam_id = l.steam_id
       ${whereSql}
       ORDER BY l.id DESC LIMIT ? OFFSET ?`,
      [...params, np.limit, np.offset],
    );

    const items_out: TransactionRow[] = rows.map((r) => ({
      at: r.at,
      steam_id: String(r.steam_id),
      discord_id: r.discord_id != null ? String(r.discord_id) : null,
      item_id: Number(r.item_id),
      item_name: r.item_name ?? null,
      kind: String(r.kind),
      amount: Number(r.amount),
      coins: Number(r.coins),
      price_per_unit: Number(r.amount) > 0 ? Math.round(Number(r.coins) / Number(r.amount)) : 0,
    }));

    return { items: items_out, total, page: np.page, limit: np.limit, pages: Math.ceil(total / np.limit) };
  }

  private normPage(page: any, limit: any): { page: number; limit: number; offset: number } {
    const p = Math.max(1, parseInt(page, 10) || 1);
    const l = Math.min(200, Math.max(1, parseInt(limit, 10) || 50));
    return { page: p, limit: l, offset: (p - 1) * l };
  }
}
