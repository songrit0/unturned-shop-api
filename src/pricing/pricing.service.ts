import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { DbService } from '../database/db.service';

@Injectable()
export class PricingService implements OnModuleInit {
  private readonly log = new Logger(PricingService.name);

  constructor(private readonly db: DbService, private readonly cfg: ConfigService) {}

  /** Computes the effective price from base, target stock, current stock and elasticity. */
  static compute(base: number, target: number, amount: number, elasticity: number, billIds: number[] = [], itemId = 0): number {
    if (!base || base <= 0) return 0;
    // Bills always sell at face value — no demand curve
    if (billIds.includes(itemId)) return Math.round(base);
    const e = Math.max(0, Math.min(elasticity ?? 0.5, 2));
    const tgt = Math.max(1, target || 1);
    const cur = Math.max(1, amount);
    const factor = Math.pow(tgt / cur, e);
    // clamp to [base * 0.1, base * 10] to keep things sane
    const raw = base * factor;
    const clamped = Math.max(base * 0.1, Math.min(raw, base * 10));
    return Math.round(clamped);
  }

  /** Recompute and persist live price for ALL market items. Returns count updated. */
  async recomputeAll(): Promise<number> {
    const market = this.db.table('sv', 'market');
    const billIds = this.cfg.get<number[]>('billItemIds') || [];

    // Auto-backfill anchors for rows missing them (e.g. items added by the bot's admin panel).
    await this.db.query(`UPDATE ${market} SET base_price = price WHERE base_price = 0 AND price > 0`);
    await this.db.query(`UPDATE ${market} SET target_stock = GREATEST(amount, 1) WHERE target_stock <= 1 AND amount > 1`);

    const rows = await this.db.query<{
      item_id: number; base_price: number; target_stock: number; amount: number; elasticity: number; price: number;
    }>(`SELECT item_id, base_price, target_stock, amount, elasticity, price FROM ${market}`);

    let n = 0;
    for (const r of rows) {
      const newPrice = PricingService.compute(
        Number(r.base_price), Number(r.target_stock),
        Number(r.amount), Number(r.elasticity), billIds, Number(r.item_id),
      );
      if (newPrice > 0 && newPrice !== Math.round(Number(r.price))) {
        await this.db.query(`UPDATE ${market} SET price = ? WHERE item_id = ?`, [newPrice, r.item_id]);
        n++;
      }
    }
    return n;
  }

  /** Recompute for a subset of items (e.g. items that just changed stock). */
  async recomputeFor(itemIds: number[]): Promise<void> {
    if (itemIds.length === 0) return;
    const market = this.db.table('sv', 'market');
    const billIds = this.cfg.get<number[]>('billItemIds') || [];
    const rows = await this.db.query<{
      item_id: number; base_price: number; target_stock: number; amount: number; elasticity: number; price: number;
    }>(
      `SELECT item_id, base_price, target_stock, amount, elasticity, price FROM ${market}
       WHERE item_id IN (${itemIds.map(() => '?').join(',')})`,
      itemIds,
    );
    for (const r of rows) {
      const newPrice = PricingService.compute(
        Number(r.base_price), Number(r.target_stock),
        Number(r.amount), Number(r.elasticity), billIds, Number(r.item_id),
      );
      if (newPrice > 0 && newPrice !== Math.round(Number(r.price))) {
        await this.db.query(`UPDATE ${market} SET price = ? WHERE item_id = ?`, [newPrice, r.item_id]);
      }
    }
  }

  onModuleInit() {
    // run once at boot to align prices after schema migration or restart
    this.recomputeAll()
      .then(n => this.log.log(`Recomputed ${n} market prices on boot`))
      .catch(e => this.log.warn(`Boot recompute failed: ${e.message}`));
  }
}
