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
  enabled: number;             // 1 = shop BUYS it (sell-to-shop board)
  enabled_isforsell: number;   // 1 = shop SELLS it (Shop page)
}

export interface UpsertInput {
  item_id: number;
  amount: number;
  base_price: number;
  target_stock: number;
  elasticity: number;
  enabled: boolean;            // shop buys it
  enabledIsForSell: boolean;   // shop sells it
}

export interface MarketExportRow {
  item_id: number;
  base_price: number;
  target_stock: number;
  elasticity: number;
  amount: number;
  enabled: boolean;
  enabled_isforsell: boolean;
}

export interface ImportResult {
  total: number;
  created: number;
  updated: number;
  failed: { item_id: number; error: string }[];
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
              i.image_url, i.type_id, t.name AS type_name, m.enabled, m.enabled_isforsell
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

  /** Every market row in import-ready shape (no pagination) for backup / bulk edit. */
  async exportAll(): Promise<MarketExportRow[]> {
    const market = this.db.table('sv', 'market');
    const rows = await this.db.query<any>(
      `SELECT item_id, base_price, target_stock, elasticity, amount, enabled, enabled_isforsell
       FROM ${market} ORDER BY item_id ASC`,
    );
    return rows.map(r => ({
      item_id: Number(r.item_id),
      base_price: Number(r.base_price),
      target_stock: Number(r.target_stock),
      elasticity: Number(r.elasticity),
      amount: Number(r.amount),
      enabled: !!r.enabled,
      enabled_isforsell: !!r.enabled_isforsell,
    }));
  }

  /**
   * Bulk upsert from an imported file. Each row is upserted independently so one
   * bad row (e.g. an item_id missing from the catalog) doesn't abort the batch;
   * it's reported in `failed` instead. created/updated is decided per row by a
   * pre-check against sv_market.
   */
  async importMany(rows: UpsertInput[]): Promise<ImportResult> {
    const market = this.db.table('sv', 'market');
    let created = 0;
    let updated = 0;
    const failed: { item_id: number; error: string }[] = [];

    for (const r of rows) {
      try {
        const ex = await this.db.first<{ c: number }>(
          `SELECT COUNT(*) AS c FROM ${market} WHERE item_id = ?`, [r.item_id],
        );
        const isNew = !ex || Number(ex.c) === 0;
        await this.upsert(r); // validates catalog membership + recomputes price
        if (isNew) created++; else updated++;
      } catch (e: any) {
        failed.push({ item_id: r.item_id, error: e?.message ?? 'upsert failed' });
      }
    }
    return { total: rows.length, created, updated, failed };
  }

  async upsert(i: UpsertInput): Promise<AdminMarketItem> {
    const market = this.db.table('sv', 'market');
    const items = this.db.table('sv', 'items');
    // item_id MUST exist in the master catalog — we never auto-create stubs here.
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
      `INSERT INTO ${market} (item_id, name, image_url, price, amount, base_price, target_stock, elasticity, enabled, enabled_isforsell)
       SELECT ?, i.name, i.image_url, ?, ?, ?, ?, ?, ?, ?
       FROM ${items} i WHERE i.id = ?
       ON DUPLICATE KEY UPDATE
         amount = VALUES(amount),
         base_price = VALUES(base_price), target_stock = VALUES(target_stock), elasticity = VALUES(elasticity),
         enabled = VALUES(enabled), enabled_isforsell = VALUES(enabled_isforsell)`,
      [i.item_id, i.base_price, i.amount, i.base_price, i.target_stock, i.elasticity,
       i.enabled ? 1 : 0, i.enabledIsForSell ? 1 : 0, i.item_id],
    );
    await this.pricing.recomputeFor([i.item_id]);
    return this.getOne(i.item_id);
  }

  /**
   * Set one or more catalog items to "buy-only": the shop BUYS them (enabled=1)
   * but does NOT sell them (enabled_isforsell=0).
   *   - already in the market -> flip the two flags, KEEPING the existing price
   *   - not in the market yet  -> create a row with default pricing (admin tunes later)
   */
  async enableBuyOnly(itemIds: number[]): Promise<{ ok: true; created: number; updated: number; failed: { item_id: number; error: string }[] }> {
    const market = this.db.table('sv', 'market');
    let created = 0;
    let updated = 0;
    const failed: { item_id: number; error: string }[] = [];

    for (const id of itemIds) {
      try {
        const ex = await this.db.first<{ c: number }>(
          `SELECT COUNT(*) AS c FROM ${market} WHERE item_id = ?`, [id],
        );
        if (ex && Number(ex.c) > 0) {
          await this.db.query(
            `UPDATE ${market} SET enabled = 1, enabled_isforsell = 0 WHERE item_id = ?`, [id],
          );
          updated++;
        } else {
          // validates catalog membership; throws -> reported in failed
          await this.upsert({ item_id: id, base_price: 100, target_stock: 10, elasticity: 0.5, amount: 0, enabled: true, enabledIsForSell: false });
          created++;
        }
      } catch (e: any) {
        failed.push({ item_id: id, error: e?.message ?? 'failed' });
      }
    }
    return { ok: true, created, updated, failed };
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

  /** Toggle whether the shop BUYS the item (sell-to-shop board). */
  async toggleEnabled(item_id: number, enabled: boolean): Promise<AdminMarketItem> {
    const market = this.db.table('sv', 'market');
    await this.db.query(`UPDATE ${market} SET enabled = ? WHERE item_id = ?`, [enabled ? 1 : 0, item_id]);
    return this.getOne(item_id);
  }

  /** Toggle whether the shop SELLS the item (Shop page). */
  async toggleForSale(item_id: number, isForSale: boolean): Promise<AdminMarketItem> {
    const market = this.db.table('sv', 'market');
    await this.db.query(`UPDATE ${market} SET enabled_isforsell = ? WHERE item_id = ?`, [isForSale ? 1 : 0, item_id]);
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
