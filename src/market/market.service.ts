import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { DbService } from '../database/db.service';
import { Paginated, normalizePage } from '../common/pagination';

export interface MarketItem {
  item_id: number;
  name: string;
  description: string | null;
  price: number;        // live effective price
  base_price: number;   // anchor (for comparison badge)
  amount: number;       // live stock
  target_stock: number;
  image_url: string | null;
  type_id: number | null;
  type_name: string | null;
}

export type MarketKind = 'normal' | 'bills' | 'all';

export interface SellPriceItem {
  item_id: number;
  name: string;
  image_url: string | null;
  type_id: number | null;
  type_name: string | null;
  buy_price: number;       // current market (buy) price
  base_price: number;      // anchor
  sell_price: number;      // what a player receives = buy_price × (1 - commission)
  trend: number;           // -1 below anchor, 0 at anchor, 1 above anchor
}

export interface SellPriceBoard {
  commission_percent: number;
  items: SellPriceItem[];
}

@Injectable()
export class MarketService {
  constructor(private readonly db: DbService, private readonly cfg: ConfigService) {}

  private get billIds(): number[] {
    return this.cfg.get<number[]>('billItemIds') || [];
  }

  async list(kind: MarketKind = 'normal', typeId?: number | null, page?: number, limit?: number): Promise<Paginated<MarketItem>> {
    const np = normalizePage(page, limit);
    const market = this.db.table('sv', 'market');
    const items = this.db.table('sv', 'items');
    const itemTypes = this.db.table('sv', 'item_types');
    const ids = this.billIds;

    const where: string[] = ['m.enabled=1', 'm.amount > 0'];
    const params: any[] = [];

    if (kind === 'bills') {
      if (ids.length === 0) return { items: [], total: 0, page: np.page, limit: np.limit, pages: 0 };
      where.push(`m.item_id IN (${ids.map(() => '?').join(',')})`);
      params.push(...ids);
    } else if (kind === 'normal' && ids.length > 0) {
      where.push(`m.item_id NOT IN (${ids.map(() => '?').join(',')})`);
      params.push(...ids);
    }

    if (typeId != null) {
      where.push('i.type_id = ?');
      params.push(typeId);
    }

    const whereSql = where.join(' AND ');
    const cnt = await this.db.first<{ c: number }>(
      `SELECT COUNT(*) AS c
       FROM ${market} m
       LEFT JOIN ${items} i ON i.id = m.item_id
       WHERE ${whereSql}`,
      params,
    );
    const total = cnt ? Number(cnt.c) : 0;

    const rows = await this.db.query<MarketItem>(
      `SELECT m.item_id, i.name, i.description, m.price, m.base_price, m.amount, m.target_stock,
              i.image_url, i.type_id, t.name AS type_name
       FROM ${market} m
       LEFT JOIN ${items} i ON i.id = m.item_id
       LEFT JOIN ${itemTypes} t ON t.id = i.type_id
       WHERE ${whereSql}
       ORDER BY m.price ASC, i.name ASC
       LIMIT ? OFFSET ?`,
      [...params, np.limit, np.offset],
    );
    return { items: rows, total, page: np.page, limit: np.limit, pages: Math.ceil(total / np.limit) };
  }

  /**
   * Public "sell to shop" board: every enabled, non-bill market item with the
   * coin payout a player receives for selling it (market price minus the shop
   * commission, mirroring the in-game SellVault). `trend` compares the live
   * price to its anchor so the UI can show an up/down arrow.
   */
  async sellPrices(typeId?: number | null): Promise<SellPriceBoard> {
    const market = this.db.table('sv', 'market');
    const items = this.db.table('sv', 'items');
    const itemTypes = this.db.table('sv', 'item_types');
    const ids = this.billIds;

    const commission = this.cfg.get<{ sellCommissionPercent: number }>('shop')?.sellCommissionPercent ?? 40;
    const rate = Math.max(0, 1 - commission / 100);

    const where: string[] = ['m.enabled=1'];
    const params: any[] = [];
    if (ids.length > 0) {
      where.push(`m.item_id NOT IN (${ids.map(() => '?').join(',')})`);
      params.push(...ids);
    }
    if (typeId != null) {
      where.push('i.type_id = ?');
      params.push(typeId);
    }

    const rows = await this.db.query<any>(
      `SELECT m.item_id, i.name, i.image_url, i.type_id, t.name AS type_name,
              m.price AS buy_price, m.base_price
       FROM ${market} m
       LEFT JOIN ${items} i ON i.id = m.item_id
       LEFT JOIN ${itemTypes} t ON t.id = i.type_id
       WHERE ${where.join(' AND ')}
       ORDER BY i.name ASC`,
      params,
    );

    const board: SellPriceItem[] = rows.map(r => {
      const buy = Number(r.buy_price);
      const base = Number(r.base_price);
      return {
        item_id: Number(r.item_id),
        name: r.name,
        image_url: r.image_url ?? null,
        type_id: r.type_id ?? null,
        type_name: r.type_name ?? null,
        buy_price: buy,
        base_price: base,
        sell_price: Math.floor(buy * rate),
        trend: buy > base ? 1 : (buy < base ? -1 : 0),
      };
    });
    return { commission_percent: commission, items: board };
  }

  async listTypes(): Promise<Array<{ id: number; name: string; description: string | null }>> {
    const itemTypes = this.db.table('sv', 'item_types');
    return this.db.query(
      `SELECT id, name, description FROM ${itemTypes} ORDER BY name ASC`,
    );
  }

  async getById(id: number): Promise<MarketItem | null> {
    const market = this.db.table('sv', 'market');
    const items = this.db.table('sv', 'items');
    const itemTypes = this.db.table('sv', 'item_types');
    return this.db.first<MarketItem>(
      `SELECT m.item_id, i.name, i.description, m.price, m.base_price, m.amount, m.target_stock,
              i.image_url, i.type_id, t.name AS type_name
       FROM ${market} m
       LEFT JOIN ${items} i ON i.id = m.item_id
       LEFT JOIN ${itemTypes} t ON t.id = i.type_id
       WHERE m.item_id = ? AND m.enabled = 1 LIMIT 1`,
      [id],
    );
  }
}
