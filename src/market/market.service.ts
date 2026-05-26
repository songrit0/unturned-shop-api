import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { DbService } from '../database/db.service';

export interface MarketItem {
  item_id: number;
  name: string;
  price: number;        // live effective price
  base_price: number;   // anchor (for comparison badge)
  amount: number;       // live stock
  target_stock: number;
  image_url: string | null;
}

export type MarketKind = 'normal' | 'bills' | 'all';

@Injectable()
export class MarketService {
  constructor(private readonly db: DbService, private readonly cfg: ConfigService) {}

  private get billIds(): number[] {
    return this.cfg.get<number[]>('billItemIds') || [];
  }

  async list(kind: MarketKind = 'normal'): Promise<MarketItem[]> {
    const market = this.db.table('sv', 'market');
    const ids = this.billIds;

    const where: string[] = ['enabled=1', 'amount > 0'];
    const params: any[] = [];

    if (kind === 'bills') {
      if (ids.length === 0) return [];
      where.push(`item_id IN (${ids.map(() => '?').join(',')})`);
      params.push(...ids);
    } else if (kind === 'normal' && ids.length > 0) {
      where.push(`item_id NOT IN (${ids.map(() => '?').join(',')})`);
      params.push(...ids);
    }

    return this.db.query<MarketItem>(
      `SELECT item_id, name, price, base_price, amount, target_stock, image_url
       FROM ${market}
       WHERE ${where.join(' AND ')}
       ORDER BY price ASC, name ASC`,
      params,
    );
  }

  async getById(id: number): Promise<MarketItem | null> {
    const market = this.db.table('sv', 'market');
    return this.db.first<MarketItem>(
      `SELECT item_id, name, price, base_price, amount, target_stock, image_url
       FROM ${market} WHERE item_id = ? AND enabled = 1 LIMIT 1`,
      [id],
    );
  }
}
