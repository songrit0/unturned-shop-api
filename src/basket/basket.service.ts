import { Injectable } from '@nestjs/common';
import { randomBytes } from 'crypto';
import { DbService } from '../database/db.service';
import { PricingService } from '../pricing/pricing.service';

const CODE_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';

export interface BasketItem { item_id: number; name: string; price: number; amount_avail: number; qty: number; image_url: string | null; }
export interface BasketView { items: BasketItem[]; total: number; }

export type CheckoutResult =
  | { ok: true; code: string; total: number; items: { item_id: number; name: string; qty: number }[] }
  | { ok: false; reason: 'empty' | 'no_item' | 'out_of_stock' | 'insufficient'; detail?: any };

@Injectable()
export class BasketService {
  /** In-memory baskets keyed by steam_id. Cleared on checkout or process restart. */
  private baskets = new Map<string, Map<number, number>>();

  constructor(
    private readonly db: DbService,
    private readonly pricing: PricingService,
  ) {}

  private get(steamId: string): Map<number, number> {
    let b = this.baskets.get(steamId);
    if (!b) { b = new Map(); this.baskets.set(steamId, b); }
    return b;
  }

  async view(steamId: string): Promise<BasketView> {
    const b = this.get(steamId);
    if (b.size === 0) return { items: [], total: 0 };

    const ids = [...b.keys()];
    const market = this.db.table('sv', 'market');
    const itemsT = this.db.table('sv', 'items');
    const rows = await this.db.query<{ item_id: number; name: string; price: number; amount: number; image_url: string | null }>(
      `SELECT m.item_id, i.name, m.price, m.amount, i.image_url
       FROM ${market} m
       LEFT JOIN ${itemsT} i ON i.id = m.item_id
       WHERE m.item_id IN (${ids.map(() => '?').join(',')}) AND m.enabled = 1`,
      ids,
    );
    const byId = new Map(rows.map(r => [Number(r.item_id), r]));

    const items: BasketItem[] = [];
    let total = 0;
    for (const [id, qty] of b) {
      const r = byId.get(id);
      if (!r) continue;
      const price = Math.round(Number(r.price));
      total += price * qty;
      items.push({ item_id: id, name: r.name, price, amount_avail: Number(r.amount), qty, image_url: r.image_url });
    }
    return { items, total };
  }

  add(steamId: string, itemId: number, qty = 1) {
    const b = this.get(steamId);
    b.set(itemId, (b.get(itemId) || 0) + qty);
  }

  setQty(steamId: string, itemId: number, qty: number) {
    const b = this.get(steamId);
    if (qty <= 0) b.delete(itemId);
    else b.set(itemId, qty);
  }

  remove(steamId: string, itemId: number) {
    this.get(steamId).delete(itemId);
  }

  clear(steamId: string) {
    this.baskets.delete(steamId);
  }

  private genCode(n = 10): string {
    const buf = randomBytes(n);
    let s = '';
    for (let i = 0; i < n; i++) s += CODE_ALPHABET[buf[i] % CODE_ALPHABET.length];
    return s;
  }

  /**
   * Atomic checkout: lock market rows, verify stock + coins, deduct, decrement stock, create rc_codes
   * + rc_code_items, insert sv_market_log. Mirrors the Discord bot's `buy_basket`.
   * Keyed on steam_id, so it works for both Discord and steam-pin logins.
   */
  async checkout(steamId: string): Promise<CheckoutResult> {
    const b = this.get(steamId);
    if (b.size === 0) return { ok: false, reason: 'empty' };

    const items = [...b.entries()].map(([item_id, qty]) => ({ item_id, qty }));

    const conn = await this.db.getConnection();
    try {
      await conn.beginTransaction();
      const market = this.db.table('sv', 'market');
      const itemsT = this.db.table('sv', 'items');
      const coins = this.db.table('sv', 'coins');
      const log = this.db.table('sv', 'market_log');
      const codes = this.db.table('rc', 'codes');
      const codeItems = this.db.table('rc', 'code_items');
      const owners = this.db.table('sv', 'code_owners');

      // 1. Lock + validate every item; compute total
      let total = 0;
      const purchased: { item_id: number; name: string; qty: number; coins: number }[] = [];
      for (const { item_id, qty } of items) {
        const [rows] = await conn.query(
          `SELECT i.name, m.price, m.amount
           FROM ${market} m
           LEFT JOIN ${itemsT} i ON i.id = m.item_id
           WHERE m.item_id = ? AND m.enabled = 1 FOR UPDATE`,
          [item_id],
        );
        const r = (rows as any[])[0];
        if (!r) { await conn.rollback(); return { ok: false, reason: 'no_item', detail: { item_id } }; }
        if (Number(r.amount) < qty) { await conn.rollback(); return { ok: false, reason: 'out_of_stock', detail: { item_id, name: r.name, have: Number(r.amount), want: qty } }; }
        const price = Math.round(Number(r.price));
        const cost = price * qty;
        total += cost;
        purchased.push({ item_id, name: r.name, qty, coins: cost });
      }

      // 2. Lock balance + deduct
      const [balRows] = await conn.query(`SELECT balance FROM ${coins} WHERE steam_id = ? FOR UPDATE`, [steamId]);
      const balance = (balRows as any[])[0] ? Number((balRows as any[])[0].balance) : 0;
      if (balance < total) { await conn.rollback(); return { ok: false, reason: 'insufficient', detail: { balance, total } }; }

      const [upd] = await conn.query(
        `UPDATE ${coins} SET balance = balance - ? WHERE steam_id = ? AND balance >= ?`,
        [total, steamId, total],
      );
      if ((upd as any).affectedRows === 0) { await conn.rollback(); return { ok: false, reason: 'insufficient', detail: { balance } }; }

      // 3. Decrement stock per item
      for (const p of purchased) {
        const [u] = await conn.query(
          `UPDATE ${market} SET amount = amount - ? WHERE item_id = ? AND amount >= ?`,
          [p.qty, p.item_id, p.qty],
        );
        if ((u as any).affectedRows === 0) { await conn.rollback(); return { ok: false, reason: 'out_of_stock', detail: { item_id: p.item_id, name: p.name } }; }
      }

      // 4. Create redeem code + items
      const code = this.genCode(10);
      const [codeIns] = await conn.query(`INSERT INTO ${codes} (code, max_uses) VALUES (?, 1)`, [code]);
      const codeId = (codeIns as any).insertId;
      await conn.query(`INSERT INTO ${owners} (code_id, steam_id) VALUES (?, ?)`, [codeId, steamId]);
      for (const p of purchased) {
        await conn.query(`INSERT INTO ${codeItems} (code_id, item_id, amount) VALUES (?, ?, ?)`, [codeId, p.item_id, p.qty]);
        await conn.query(
          `INSERT INTO ${log} (steam_id, item_id, amount, coins, kind) VALUES (?, ?, ?, ?, 'buy')`,
          [steamId, p.item_id, p.qty, p.coins],
        );
      }

      await conn.commit();
      this.clear(steamId);
      // Recompute live prices for items whose stock just changed
      this.pricing.recomputeFor(purchased.map(p => p.item_id)).catch(() => {});
      return { ok: true, code, total, items: purchased.map(p => ({ item_id: p.item_id, name: p.name, qty: p.qty })) };
    } catch (e) {
      try { await conn.rollback(); } catch {}
      throw e;
    } finally {
      conn.release();
    }
  }
}
