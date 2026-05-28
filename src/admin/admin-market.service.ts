import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { DbService } from '../database/db.service';
import { PricingService } from '../pricing/pricing.service';
import { Paginated, normalizePage } from '../common/pagination';

export interface AdminMarketItem {
  item_id: number;
  name: string;
  description: string | null;
  price: number;          // live effective price
  amount: number;         // current stock
  base_price: number; target_stock: number; elasticity: number;
  image_url: string | null;
  type_id: number | null;
  type_name: string | null;
  enabled: number;
}

export interface UpsertInput {
  item_id: number;
  amount: number;
  base_price: number;
  target_stock: number;
  elasticity: number;
  enabled: boolean;
}

@Injectable()
export class AdminMarketService {
  constructor(private readonly db: DbService, private readonly pricing: PricingService) {}

  private joinedSelect(extraWhere: string, params: any[]): { sql: string; params: any[] } {
    const market = this.db.table('sv', 'market');
    const items = this.db.table('sv', 'items');
    const types = this.db.table('sv', 'item_types');
    const sql =
      `SELECT m.item_id, i.name, i.description, m.price, m.amount,
              m.base_price, m.target_stock, m.elasticity,
              i.image_url, i.type_id, t.name AS type_name, m.enabled
       FROM ${market} m
       LEFT JOIN ${items} i ON i.id = m.item_id
       LEFT JOIN ${types} t ON t.id = i.type_id
       ${extraWhere}`;
    return { sql, params };
  }

  async listAll(page?: number, limit?: number): Promise<Paginated<AdminMarketItem>> {
    const np = normalizePage(page, limit);
    const market = this.db.table('sv', 'market');

    const cnt = await this.db.first<{ c: number }>(`SELECT COUNT(*) AS c FROM ${market}`);
    const total = cnt ? Number(cnt.c) : 0;

    const { sql, params } = this.joinedSelect(`ORDER BY m.item_id ASC LIMIT ? OFFSET ?`, [np.limit, np.offset]);
    const items = await this.db.query<AdminMarketItem>(sql, params);
    return { items, total, page: np.page, limit: np.limit, pages: Math.ceil(total / np.limit) };
  }

  async upsert(i: UpsertInput): Promise<AdminMarketItem> {
    const market = this.db.table('sv', 'market');
    const items = this.db.table('sv', 'items');
    // item_id MUST exist in master catalog — don't auto-create
    const exists = await this.db.first<{ c: number }>(
      `SELECT COUNT(*) AS c FROM ${items} WHERE id = ?`, [i.item_id],
    );
    if (!exists || Number(exists.c) === 0) {
      throw new BadRequestException('Item not found in catalog');
    }

    // Pull name/image_url from sv_items in the same statement so the INSERT still
    // satisfies NOT NULL constraints on legacy sv_market.name / sv_market.image_url
    // when SHOP_API_DROP_LEGACY_MARKET_COLS is unset. After those columns are dropped,
    // remove `name`, `image_url` from the column list and the SELECT projection.
    await this.db.query(
      `INSERT INTO ${market} (item_id, name, image_url, price, amount, base_price, target_stock, elasticity, enabled)
       SELECT ?, i.name, i.image_url, ?, ?, ?, ?, ?, ?
       FROM ${items} i WHERE i.id = ?
       ON DUPLICATE KEY UPDATE
         amount = VALUES(amount),
         base_price = VALUES(base_price), target_stock = VALUES(target_stock), elasticity = VALUES(elasticity),
         enabled = VALUES(enabled)`,
      [i.item_id, i.base_price, i.amount, i.base_price, i.target_stock, i.elasticity, i.enabled ? 1 : 0, i.item_id],
    );
    await this.pricing.recomputeFor([i.item_id]);
    return this.getOne(i.item_id);
  }

  async getOne(item_id: number): Promise<AdminMarketItem> {
    const { sql, params } = this.joinedSelect(`WHERE m.item_id = ?`, [item_id]);
    const row = await this.db.first<AdminMarketItem>(sql, params);
    if (!row) throw new NotFoundException('Item not found');
    return row;
  }

  async remove(item_id: number): Promise<{ ok: true; deleted: number }> {
    const market = this.db.table('sv', 'market');
    const result: any = await this.db.query(
      `DELETE FROM ${market} WHERE item_id = ?`, [item_id],
    );
    const affected = Array.isArray(result) ? 0 : Number(result?.affectedRows || 0);
    return { ok: true, deleted: affected };
  }

  async toggleEnabled(item_id: number, enabled: boolean): Promise<AdminMarketItem> {
    const market = this.db.table('sv', 'market');
    await this.db.query(`UPDATE ${market} SET enabled = ? WHERE item_id = ?`, [enabled ? 1 : 0, item_id]);
    return this.getOne(item_id);
  }

  /** Set type on master catalog (sv_items.type_id), not on sv_market. */
  async setType(item_id: number, type_id: number | null): Promise<AdminMarketItem> {
    const items = this.db.table('sv', 'items');
    const exists = await this.db.first<{ c: number }>(`SELECT COUNT(*) AS c FROM ${items} WHERE id = ?`, [item_id]);
    if (!exists || Number(exists.c) === 0) throw new NotFoundException('Item not found in catalog');
    await this.db.query(`UPDATE ${items} SET type_id = ? WHERE id = ?`, [type_id, item_id]);
    return this.getOne(item_id);
  }
}
