import { Injectable, NotFoundException } from '@nestjs/common';
import { DbService } from '../database/db.service';
import { PricingService } from '../pricing/pricing.service';

export interface AdminMarketItem {
  item_id: number; name: string;
  price: number;          // live effective price
  amount: number;         // current stock
  base_price: number; target_stock: number; elasticity: number;
  image_url: string | null; enabled: number;
}

export interface UpsertInput {
  item_id: number; name: string; amount: number;
  base_price: number; target_stock: number; elasticity: number;
  image_url: string | null; enabled: boolean;
}

@Injectable()
export class AdminMarketService {
  constructor(private readonly db: DbService, private readonly pricing: PricingService) {}

  async listAll(): Promise<AdminMarketItem[]> {
    const market = this.db.table('sv', 'market');
    return this.db.query<AdminMarketItem>(
      `SELECT item_id, name, price, amount, base_price, target_stock, elasticity, image_url, enabled
       FROM ${market} ORDER BY item_id ASC`,
    );
  }

  async upsert(i: UpsertInput): Promise<AdminMarketItem> {
    const market = this.db.table('sv', 'market');
    // initial price = base (will be re-computed below)
    await this.db.query(
      `INSERT INTO ${market} (item_id, name, price, amount, base_price, target_stock, elasticity, image_url, enabled)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE
         name = VALUES(name), amount = VALUES(amount),
         base_price = VALUES(base_price), target_stock = VALUES(target_stock), elasticity = VALUES(elasticity),
         image_url = COALESCE(VALUES(image_url), image_url), enabled = VALUES(enabled)`,
      [i.item_id, i.name, i.base_price, i.amount, i.base_price, i.target_stock, i.elasticity,
       i.image_url, i.enabled ? 1 : 0],
    );
    await this.pricing.recomputeFor([i.item_id]);
    return this.getOne(i.item_id);
  }

  async getOne(item_id: number): Promise<AdminMarketItem> {
    const market = this.db.table('sv', 'market');
    const row = await this.db.first<AdminMarketItem>(
      `SELECT item_id, name, price, amount, base_price, target_stock, elasticity, image_url, enabled
       FROM ${market} WHERE item_id = ?`,
      [item_id],
    );
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
}
