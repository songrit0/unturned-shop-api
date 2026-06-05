import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { DbService } from '../database/db.service';
import { Paginated, normalizePage } from '../common/pagination';

export interface AdminVehicleMarketItem {
  vehicle_id: number;
  name: string;
  description: string | null;
  price: number;          // fixed price
  amount: number;         // current stock
  image_url: string | null;
  type_id: number | null;
  type_name: string | null;
  enabled: number;        // 1 = shop SELLS it (Shop page)
  meowcoin_price: number | null; // Meowcoin price, null = not buyable with Meowcoin
}

export interface UpsertVehicleMarketInput {
  vehicle_id: number;
  price: number;
  amount: number;
  enabled: boolean;
  /** Meowcoin price; null/undefined clears it (not buyable with Meowcoin). */
  meowcoinPrice?: number | null;
}

@Injectable()
export class AdminVehicleMarketService {
  constructor(private readonly db: DbService) {}

  private joinedSelect(extraWhere: string, params: any[]): { sql: string; params: any[] } {
    const market = this.db.table('sv', 'vehicle_market');
    const vehicles = this.db.table('sv', 'vehicles');
    const types = this.db.table('sv', 'item_types');
    const sql =
      `SELECT m.vehicle_id, v.name, v.description, m.price, m.amount,
              v.image_url, v.type_id, t.name AS type_name, m.enabled, m.meowcoin_price
       FROM ${market} m
       LEFT JOIN ${vehicles} v ON v.id = m.vehicle_id
       LEFT JOIN ${types} t ON t.id = v.type_id
       ${extraWhere}`;
    return { sql, params };
  }

  async listAll(page?: number, limit?: number): Promise<Paginated<AdminVehicleMarketItem>> {
    const np = normalizePage(page, limit);
    const market = this.db.table('sv', 'vehicle_market');

    const cnt = await this.db.first<{ c: number }>(`SELECT COUNT(*) AS c FROM ${market}`);
    const total = cnt ? Number(cnt.c) : 0;

    const { sql, params } = this.joinedSelect(`ORDER BY m.vehicle_id ASC LIMIT ? OFFSET ?`, [np.limit, np.offset]);
    const items = await this.db.query<AdminVehicleMarketItem>(sql, params);
    return { items, total, page: np.page, limit: np.limit, pages: Math.ceil(total / np.limit) };
  }

  async getOne(vehicle_id: number): Promise<AdminVehicleMarketItem> {
    const { sql, params } = this.joinedSelect(`WHERE m.vehicle_id = ?`, [vehicle_id]);
    const row = await this.db.first<AdminVehicleMarketItem>(sql, params);
    if (!row) throw new NotFoundException('Vehicle not found');
    return row;
  }

  async upsert(i: UpsertVehicleMarketInput): Promise<AdminVehicleMarketItem> {
    const market = this.db.table('sv', 'vehicle_market');
    const vehicles = this.db.table('sv', 'vehicles');
    // vehicle_id MUST exist in the master catalog — we never auto-create stubs here.
    const exists = await this.db.first<{ c: number }>(
      `SELECT COUNT(*) AS c FROM ${vehicles} WHERE id = ?`, [i.vehicle_id],
    );
    if (!exists || Number(exists.c) === 0) {
      throw new BadRequestException('Vehicle not found in catalog');
    }

    // Normalise the Meowcoin price tag: a finite int >= 0 sets it, anything else clears it.
    const meowcoinPrice =
      i.meowcoinPrice == null || !Number.isFinite(Number(i.meowcoinPrice))
        ? null
        : Math.trunc(Number(i.meowcoinPrice));

    await this.db.query(
      `INSERT INTO ${market} (vehicle_id, price, amount, enabled, meowcoin_price)
       VALUES (?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE
         price = VALUES(price),
         amount = VALUES(amount),
         enabled = VALUES(enabled),
         meowcoin_price = VALUES(meowcoin_price)`,
      [i.vehicle_id, i.price, i.amount, i.enabled ? 1 : 0, meowcoinPrice],
    );
    return this.getOne(i.vehicle_id);
  }

  /** Toggle whether the shop SELLS the vehicle (Shop page). */
  async toggleEnabled(vehicle_id: number, enabled: boolean): Promise<AdminVehicleMarketItem> {
    const market = this.db.table('sv', 'vehicle_market');
    await this.db.query(`UPDATE ${market} SET enabled = ? WHERE vehicle_id = ?`, [enabled ? 1 : 0, vehicle_id]);
    return this.getOne(vehicle_id);
  }

  async remove(vehicle_id: number): Promise<{ ok: true; deleted: number }> {
    const market = this.db.table('sv', 'vehicle_market');
    const result: any = await this.db.query(
      `DELETE FROM ${market} WHERE vehicle_id = ?`, [vehicle_id],
    );
    const affected = Array.isArray(result) ? 0 : Number(result?.affectedRows || 0);
    return { ok: true, deleted: affected };
  }
}
