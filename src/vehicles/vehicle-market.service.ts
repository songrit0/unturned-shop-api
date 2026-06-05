import { Injectable } from '@nestjs/common';
import { DbService } from '../database/db.service';
import { Paginated, normalizePage } from '../common/pagination';

export interface VehicleMarketItem {
  vehicle_id: number;
  name: string;
  price: number;          // fixed price
  amount: number;         // current stock
  image_url: string | null;
  type_id: number | null;
  type_name: string | null;
  /** Meowcoin price, or null when not buyable with Meowcoin. */
  meowcoin_price: number | null;
}

@Injectable()
export class VehicleMarketService {
  constructor(private readonly db: DbService) {}

  async list(q?: string, typeId?: number | null, page?: number, limit?: number): Promise<Paginated<VehicleMarketItem>> {
    const np = normalizePage(page, limit);
    const market = this.db.table('sv', 'vehicle_market');
    const vehicles = this.db.table('sv', 'vehicles');
    const itemTypes = this.db.table('sv', 'item_types');

    // Public shop = vehicles the shop SELLS to players (enabled=1).
    const where: string[] = ['m.enabled = 1'];
    const params: any[] = [];
    if (q) {
      where.push('v.name LIKE ?');
      params.push(`%${q}%`);
    }
    if (typeId != null) {
      where.push('v.type_id = ?');
      params.push(typeId);
    }
    const whereSql = where.join(' AND ');

    const cnt = await this.db.first<{ c: number }>(
      `SELECT COUNT(*) AS c
       FROM ${market} m
       LEFT JOIN ${vehicles} v ON v.id = m.vehicle_id
       WHERE ${whereSql}`,
      params,
    );
    const total = cnt ? Number(cnt.c) : 0;

    const rows = await this.db.query<VehicleMarketItem>(
      `SELECT m.vehicle_id, v.name, m.price, m.amount,
              v.image_url, v.type_id, t.name AS type_name, m.meowcoin_price
       FROM ${market} m
       LEFT JOIN ${vehicles} v ON v.id = m.vehicle_id
       LEFT JOIN ${itemTypes} t ON t.id = v.type_id
       WHERE ${whereSql}
       ORDER BY m.price ASC, v.name ASC
       LIMIT ? OFFSET ?`,
      [...params, np.limit, np.offset],
    );
    return { items: rows, total, page: np.page, limit: np.limit, pages: Math.ceil(total / np.limit) };
  }

  async getById(id: number): Promise<VehicleMarketItem | null> {
    const market = this.db.table('sv', 'vehicle_market');
    const vehicles = this.db.table('sv', 'vehicles');
    const itemTypes = this.db.table('sv', 'item_types');
    return this.db.first<VehicleMarketItem>(
      `SELECT m.vehicle_id, v.name, m.price, m.amount,
              v.image_url, v.type_id, t.name AS type_name, m.meowcoin_price
       FROM ${market} m
       LEFT JOIN ${vehicles} v ON v.id = m.vehicle_id
       LEFT JOIN ${itemTypes} t ON t.id = v.type_id
       WHERE m.vehicle_id = ? AND m.enabled = 1 LIMIT 1`,
      [id],
    );
  }
}
