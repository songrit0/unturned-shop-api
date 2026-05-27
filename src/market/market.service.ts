import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { DbService } from '../database/db.service';

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

@Injectable()
export class MarketService {
  constructor(private readonly db: DbService, private readonly cfg: ConfigService) {}

  private get billIds(): number[] {
    return this.cfg.get<number[]>('billItemIds') || [];
  }

  async list(kind: MarketKind = 'normal', typeId?: number | null): Promise<MarketItem[]> {
    const market = this.db.table('sv', 'market');
    const items = this.db.table('sv', 'items');
    const itemTypes = this.db.table('sv', 'item_types');
    const ids = this.billIds;

    const where: string[] = ['m.enabled=1', 'm.amount > 0'];
    const params: any[] = [];

    if (kind === 'bills') {
      if (ids.length === 0) return [];
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

    return this.db.query<MarketItem>(
      `SELECT m.item_id, i.name, i.description, m.price, m.base_price, m.amount, m.target_stock,
              i.image_url, i.type_id, t.name AS type_name
       FROM ${market} m
       LEFT JOIN ${items} i ON i.id = m.item_id
       LEFT JOIN ${itemTypes} t ON t.id = i.type_id
       WHERE ${where.join(' AND ')}
       ORDER BY m.price ASC, i.name ASC`,
      params,
    );
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
