import { Injectable } from '@nestjs/common';
import { randomBytes } from 'crypto';
import { DbService } from '../database/db.service';
import { PricingService } from '../pricing/pricing.service';

const CODE_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';

export type BasketKind = 'item' | 'vehicle';

export interface BasketItem { item_id: number; kind: BasketKind; name: string; price: number; amount_avail: number; qty: number; image_url: string | null; }
export interface BasketView { items: BasketItem[]; total: number; }

export type CheckoutResult =
  | { ok: true; code: string; total: number; items: { item_id: number; kind: BasketKind; name: string; qty: number }[] }
  | { ok: false; reason: 'empty' | 'no_item' | 'out_of_stock' | 'insufficient'; detail?: any };

/** Composite basket key — vehicle IDs and item IDs are separate id spaces. */
function keyOf(kind: BasketKind, id: number): string { return `${kind}:${id}`; }
function parseKey(key: string): { kind: BasketKind; id: number } {
  const idx = key.indexOf(':');
  return { kind: key.slice(0, idx) as BasketKind, id: Number(key.slice(idx + 1)) };
}

@Injectable()
export class BasketService {
  /**
   * In-memory baskets keyed by steam_id. Each basket maps a composite
   * `${kind}:${id}` key -> qty, so a single cart can hold both items and
   * vehicles (separate Unturned id spaces). Cleared on checkout or restart.
   */
  private baskets = new Map<string, Map<string, number>>();

  constructor(
    private readonly db: DbService,
    private readonly pricing: PricingService,
  ) {}

  private get(steamId: string): Map<string, number> {
    let b = this.baskets.get(steamId);
    if (!b) { b = new Map(); this.baskets.set(steamId, b); }
    return b;
  }

  async view(steamId: string): Promise<BasketView> {
    const b = this.get(steamId);
    if (b.size === 0) return { items: [], total: 0 };

    const itemIds: number[] = [];
    const vehicleIds: number[] = [];
    for (const key of b.keys()) {
      const { kind, id } = parseKey(key);
      if (kind === 'vehicle') vehicleIds.push(id);
      else itemIds.push(id);
    }

    // Item lines: sv_market + sv_items (live supply/demand price), enabled only.
    const itemById = new Map<number, { name: string; price: number; amount: number; image_url: string | null }>();
    if (itemIds.length > 0) {
      const market = this.db.table('sv', 'market');
      const itemsT = this.db.table('sv', 'items');
      const rows = await this.db.query<{ item_id: number; name: string; price: number; amount: number; image_url: string | null }>(
        `SELECT m.item_id, i.name, m.price, m.amount, i.image_url
         FROM ${market} m
         LEFT JOIN ${itemsT} i ON i.id = m.item_id
         WHERE m.item_id IN (${itemIds.map(() => '?').join(',')}) AND m.enabled = 1`,
        itemIds,
      );
      for (const r of rows) itemById.set(Number(r.item_id), r);
    }

    // Vehicle lines: sv_vehicle_market + sv_vehicles (fixed price), enabled only.
    const vehicleById = new Map<number, { name: string; price: number; amount: number; image_url: string | null }>();
    if (vehicleIds.length > 0) {
      const vmarket = this.db.table('sv', 'vehicle_market');
      const vehiclesT = this.db.table('sv', 'vehicles');
      const rows = await this.db.query<{ vehicle_id: number; name: string; price: number; amount: number; image_url: string | null }>(
        `SELECT m.vehicle_id, v.name, m.price, m.amount, v.image_url
         FROM ${vmarket} m
         LEFT JOIN ${vehiclesT} v ON v.id = m.vehicle_id
         WHERE m.vehicle_id IN (${vehicleIds.map(() => '?').join(',')}) AND m.enabled = 1`,
        vehicleIds,
      );
      for (const r of rows) vehicleById.set(Number(r.vehicle_id), r);
    }

    const items: BasketItem[] = [];
    let total = 0;
    for (const [key, qty] of b) {
      const { kind, id } = parseKey(key);
      const r = kind === 'vehicle' ? vehicleById.get(id) : itemById.get(id);
      if (!r) continue;
      const price = Math.round(Number(r.price));
      total += price * qty;
      items.push({ item_id: id, kind, name: r.name, price, amount_avail: Number(r.amount), qty, image_url: r.image_url });
    }
    return { items, total };
  }

  add(steamId: string, itemId: number, qty = 1, kind: BasketKind = 'item') {
    const b = this.get(steamId);
    const key = keyOf(kind, itemId);
    b.set(key, (b.get(key) || 0) + qty);
  }

  setQty(steamId: string, itemId: number, qty: number, kind: BasketKind = 'item') {
    const b = this.get(steamId);
    const key = keyOf(kind, itemId);
    if (qty <= 0) b.delete(key);
    else b.set(key, qty);
  }

  remove(steamId: string, itemId: number, kind: BasketKind = 'item') {
    this.get(steamId).delete(keyOf(kind, itemId));
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

    const lines = [...b.entries()].map(([key, qty]) => {
      const { kind, id } = parseKey(key);
      return { item_id: id, kind, qty };
    });

    const conn = await this.db.getConnection();
    try {
      await conn.beginTransaction();
      const market = this.db.table('sv', 'market');
      const itemsT = this.db.table('sv', 'items');
      const vmarket = this.db.table('sv', 'vehicle_market');
      const vehiclesT = this.db.table('sv', 'vehicles');
      const coins = this.db.table('sv', 'coins');
      const log = this.db.table('sv', 'market_log');
      const codes = this.db.table('rc', 'codes');
      const codeItems = this.db.table('rc', 'code_items');
      const owners = this.db.table('sv', 'code_owners');

      // 1. Lock + validate every line; compute total
      let total = 0;
      const purchased: { item_id: number; kind: BasketKind; name: string; qty: number; coins: number }[] = [];
      for (const { item_id, kind, qty } of lines) {
        let row: any;
        if (kind === 'vehicle') {
          const [rows] = await conn.query(
            `SELECT v.name, m.price, m.amount
             FROM ${vmarket} m
             LEFT JOIN ${vehiclesT} v ON v.id = m.vehicle_id
             WHERE m.vehicle_id = ? AND m.enabled = 1 FOR UPDATE`,
            [item_id],
          );
          row = (rows as any[])[0];
        } else {
          const [rows] = await conn.query(
            `SELECT i.name, m.price, m.amount
             FROM ${market} m
             LEFT JOIN ${itemsT} i ON i.id = m.item_id
             WHERE m.item_id = ? AND m.enabled = 1 FOR UPDATE`,
            [item_id],
          );
          row = (rows as any[])[0];
        }
        if (!row) { await conn.rollback(); return { ok: false, reason: 'no_item', detail: { item_id, kind } }; }
        if (Number(row.amount) < qty) { await conn.rollback(); return { ok: false, reason: 'out_of_stock', detail: { item_id, kind, name: row.name, have: Number(row.amount), want: qty } }; }
        const price = Math.round(Number(row.price));
        const cost = price * qty;
        total += cost;
        purchased.push({ item_id, kind, name: row.name, qty, coins: cost });
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

      // 3. Decrement stock per line (item -> sv_market, vehicle -> sv_vehicle_market)
      for (const p of purchased) {
        const [u] = p.kind === 'vehicle'
          ? await conn.query(
              `UPDATE ${vmarket} SET amount = amount - ? WHERE vehicle_id = ? AND amount >= ?`,
              [p.qty, p.item_id, p.qty],
            )
          : await conn.query(
              `UPDATE ${market} SET amount = amount - ? WHERE item_id = ? AND amount >= ?`,
              [p.qty, p.item_id, p.qty],
            );
        if ((u as any).affectedRows === 0) { await conn.rollback(); return { ok: false, reason: 'out_of_stock', detail: { item_id: p.item_id, kind: p.kind, name: p.name } }; }
      }

      // 4. Create redeem code + items. rc_code_items.kind: 0=item, 1=vehicle (the
      //    game plugin reads it to know which Unturned id space item_id refers to).
      const code = this.genCode(10);
      const [codeIns] = await conn.query(`INSERT INTO ${codes} (code, max_uses) VALUES (?, 1)`, [code]);
      const codeId = (codeIns as any).insertId;
      await conn.query(`INSERT INTO ${owners} (code_id, steam_id) VALUES (?, ?)`, [codeId, steamId]);
      for (const p of purchased) {
        await conn.query(
          `INSERT INTO ${codeItems} (code_id, item_id, amount, kind) VALUES (?, ?, ?, ?)`,
          [codeId, p.item_id, p.qty, p.kind === 'vehicle' ? 1 : 0],
        );
        // Only item lines are recorded in sv_market_log (it is item/pricing-only).
        if (p.kind !== 'vehicle') {
          await conn.query(
            `INSERT INTO ${log} (steam_id, item_id, amount, coins, kind) VALUES (?, ?, ?, ?, 'buy')`,
            [steamId, p.item_id, p.qty, p.coins],
          );
        }
      }

      await conn.commit();
      this.clear(steamId);
      // Recompute live prices only for the (item-only) ids whose stock just changed.
      const itemIds = purchased.filter(p => p.kind !== 'vehicle').map(p => p.item_id);
      if (itemIds.length > 0) this.pricing.recomputeFor(itemIds).catch(() => {});
      return { ok: true, code, total, items: purchased.map(p => ({ item_id: p.item_id, kind: p.kind, name: p.name, qty: p.qty })) };
    } catch (e) {
      try { await conn.rollback(); } catch {}
      throw e;
    } finally {
      conn.release();
    }
  }
}
