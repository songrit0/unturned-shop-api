import {
  BadRequestException, ConflictException, ForbiddenException,
  Injectable, Logger, NotFoundException, OnModuleInit,
} from '@nestjs/common';
import * as mysql from 'mysql2/promise';
import { DbService } from '../database/db.service';
import { UsersService } from '../users/users.service';
import { PurchasesService } from '../purchases/purchases.service';
import {
  DailyAdminConfig, DailyClaimResult, DailyKind, DailyRewardBundle,
  DailyRewardGood, DailyRewardItem, DailyStatus, DailyTier, DailyTierAdminView,
} from './daily.types';

const THAI_OFFSET_MS = 7 * 60 * 60 * 1000;
const RESET_HOUR = 6; // daily reset at 06:00 Thai — same boundary as the gacha day.
const TIERS: DailyTier[] = ['normal', 'vip'];

/** Minimal slice of the JWT payload needed to identify the caller. */
type DailyUser = { steam_id: string | null; sub: string | null };

/** Mutable fields an admin may set on a tier's scalar config. */
export interface DailyTierConfigInput {
  enabled?: boolean;
  coins?: number;
  codeTtlDays?: number;
}

/** Fields for creating/updating one reward-item row. label/imageUrl are NOT stored —
 *  they live-reference the Master Items catalogs by (kind, item_id). */
export interface DailyItemInput {
  tier?: DailyTier;
  itemId?: number;
  amount?: number;
  quality?: number;
  kind?: DailyKind;
  sort?: number;
  enabled?: boolean;
}

@Injectable()
export class DailyService implements OnModuleInit {
  private readonly log = new Logger(DailyService.name);

  constructor(
    private readonly db: DbService,
    private readonly users: UsersService,
    private readonly purchases: PurchasesService,
  ) {}

  // ---- table refs ----
  private configTbl() { return this.db.table('sv', 'daily_reward_config'); }
  private itemsTbl() { return this.db.table('sv', 'daily_reward_items'); }
  private claimsTbl() { return this.db.table('sv', 'daily_claims'); }
  private coinsTbl() { return this.db.table('sv', 'coins'); }
  private grantsTbl() { return this.db.table('sv', 'vip_grants'); }
  private codeItemsTbl() { return this.db.table('rc', 'code_items'); }
  private codeOwnersTbl() { return this.db.table('sv', 'code_owners'); }
  // Master Items catalogs the daily items live-reference for name/image (kind 0 -> items, 1 -> vehicles).
  private catalogTbl() { return this.db.table('sv', 'items'); }
  private vehicleCatalogTbl() { return this.db.table('sv', 'vehicles'); }

  async onModuleInit() {
    try {
      // (a) per-tier scalar bundle: coins + flags. One row per tier, seeded.
      await this.db.query(
        `CREATE TABLE IF NOT EXISTS ${this.configTbl()} (
          tier ENUM('normal','vip') NOT NULL,
          enabled TINYINT(1) NOT NULL DEFAULT 1,
          coins BIGINT NOT NULL DEFAULT 0,
          code_ttl_days INT NOT NULL DEFAULT 30,
          updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
          PRIMARY KEY (tier)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
      );
      // Seed both tier rows if absent.
      await this.db.query(
        `INSERT IGNORE INTO ${this.configTbl()} (tier, enabled, coins, code_ttl_days)
         VALUES ('normal', 1, 0, 30), ('vip', 1, 0, 30)`,
      );

      // (b) per-tier item/vehicle list. kind 0=item, 1=vehicle.
      await this.db.query(
        `CREATE TABLE IF NOT EXISTS ${this.itemsTbl()} (
          id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
          tier ENUM('normal','vip') NOT NULL,
          item_id INT UNSIGNED NOT NULL,
          amount INT UNSIGNED NOT NULL DEFAULT 1,
          quality TINYINT UNSIGNED NOT NULL DEFAULT 100,
          kind TINYINT UNSIGNED NOT NULL DEFAULT 0,
          sort INT NOT NULL DEFAULT 0,
          enabled TINYINT(1) NOT NULL DEFAULT 1,
          PRIMARY KEY (id),
          INDEX idx_tier (tier, enabled, sort)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
      );

      // (c) claim ledger — UNIQUE(steam_id, claim_date) is the race-safe once-per-day gate.
      await this.db.query(
        `CREATE TABLE IF NOT EXISTS ${this.claimsTbl()} (
          id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
          steam_id CHAR(17) NOT NULL,
          claim_date VARCHAR(10) NOT NULL,
          tier ENUM('normal','vip') NOT NULL,
          coins BIGINT NOT NULL DEFAULT 0,
          redeem_code VARCHAR(64) NULL,
          created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
          PRIMARY KEY (id),
          UNIQUE KEY uq_steam_day (steam_id, claim_date),
          INDEX idx_day (claim_date)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
      );
      this.log.log('Daily reward tables ready');
    } catch (e: any) {
      this.log.warn(`Daily ensureSchema failed: ${e.message}`);
    }
  }

  // ---- time helpers (06:00 Thai boundary, identical to gacha) ----
  /** Current daily-day key (YYYY-MM-DD), rolling over at 06:00 Thai. */
  dailyDay(nowMs: number = Date.now()): string {
    const shifted = new Date(nowMs + THAI_OFFSET_MS - RESET_HOUR * 3600_000);
    const y = shifted.getUTCFullYear();
    const m = String(shifted.getUTCMonth() + 1).padStart(2, '0');
    const d = String(shifted.getUTCDate()).padStart(2, '0');
    return `${y}-${m}-${d}`;
  }

  /** Real UTC instant of the next 06:00 Thai reset. */
  nextResetAt(nowMs: number = Date.now()): Date {
    const thaiNow = new Date(nowMs + THAI_OFFSET_MS);
    let target = Date.UTC(
      thaiNow.getUTCFullYear(), thaiNow.getUTCMonth(), thaiNow.getUTCDate(), RESET_HOUR, 0, 0,
    );
    if (target <= thaiNow.getTime()) target += 86_400_000;
    return new Date(target - THAI_OFFSET_MS);
  }

  // ---- identity + tier ----
  private async resolveSteam(user: DailyUser): Promise<string> {
    const steam = user.steam_id ?? (await this.users.findSteamByDiscord(user.sub));
    if (!steam) throw new ForbiddenException('not_linked');
    return steam;
  }

  /** 'vip' if the steamId has any active, unexpired VIP grant; otherwise 'normal'. */
  private async resolveTier(steam: string): Promise<DailyTier> {
    const row = await this.db.first<{ c: number }>(
      `SELECT COUNT(*) AS c FROM ${this.grantsTbl()}
       WHERE steam_id = ? AND active = 1 AND expires_at > UTC_TIMESTAMP()`,
      [steam],
    );
    return row && Number(row.c) > 0 ? 'vip' : 'normal';
  }

  // ---- config + items reads ----
  /** Map a daily_reward_items row. label/imageUrl come from the catalog JOIN aliases
   *  (cat_name/cat_image) when present, else null — they are never stored on the row. */
  private mapItem(r: any): DailyRewardItem {
    return {
      id: Number(r.id),
      tier: r.tier,
      itemId: Number(r.item_id),
      amount: Number(r.amount),
      quality: Number(r.quality),
      kind: (Number(r.kind) === 1 ? 1 : 0) as DailyKind,
      label: r.cat_name ?? null,
      imageUrl: r.cat_image ?? null,
      sort: Number(r.sort),
      enabled: Number(r.enabled) === 1,
    };
  }

  /** SELECT list that LEFT JOINs both Master Items catalogs and resolves label/image by kind.
   *  kind=0 -> sv_items, kind=1 -> sv_vehicles. Missing catalog row -> NULL (no crash). */
  private itemsSelectSql(whereSql: string): string {
    return `SELECT d.*,
                   COALESCE(it.name, ve.name) AS cat_name,
                   COALESCE(it.image_url, ve.image_url) AS cat_image
            FROM ${this.itemsTbl()} d
            LEFT JOIN ${this.catalogTbl()} it ON d.kind = 0 AND it.id = d.item_id
            LEFT JOIN ${this.vehicleCatalogTbl()} ve ON d.kind = 1 AND ve.id = d.item_id
            ${whereSql}`;
  }

  private async tierConfigRow(tier: DailyTier): Promise<{ enabled: boolean; coins: number; codeTtlDays: number }> {
    const row = await this.db.first<any>(
      `SELECT enabled, coins, code_ttl_days FROM ${this.configTbl()} WHERE tier = ?`, [tier],
    );
    return {
      enabled: row ? Number(row.enabled) === 1 : true,
      coins: Number(row?.coins ?? 0),
      codeTtlDays: Number(row?.code_ttl_days ?? 30),
    };
  }

  private async tierItems(tier: DailyTier, enabledOnly: boolean): Promise<DailyRewardItem[]> {
    const where = enabledOnly ? 'WHERE d.tier = ? AND d.enabled = 1' : 'WHERE d.tier = ?';
    const rows = await this.db.query<any>(
      `${this.itemsSelectSql(where)} ORDER BY d.sort ASC, d.id ASC`, [tier],
    );
    return rows.map((r) => this.mapItem(r));
  }

  /** A tier's grantable bundle (coins + enabled items/vehicles), shaped for the player. */
  private async tierBundle(tier: DailyTier): Promise<DailyRewardBundle> {
    const cfg = await this.tierConfigRow(tier);
    const items = await this.tierItems(tier, true);
    const toGood = (i: DailyRewardItem): DailyRewardGood => ({
      itemId: i.itemId, amount: i.amount, quality: i.quality,
      label: i.label, imageUrl: i.imageUrl, kind: i.kind,
    });
    return {
      coins: cfg.coins,
      items: items.filter((i) => i.kind === 0).map(toGood),
      vehicles: items.filter((i) => i.kind === 1).map(toGood),
    };
  }

  // ---- player: status ----
  async status(user: DailyUser): Promise<DailyStatus> {
    const steam = await this.resolveSteam(user);
    const tier = await this.resolveTier(steam);
    const cfg = await this.tierConfigRow(tier);
    const day = this.dailyDay();

    const claimed = await this.db.first<{ id: number }>(
      `SELECT id FROM ${this.claimsTbl()} WHERE steam_id = ? AND claim_date = ?`, [steam, day],
    );
    const alreadyClaimedToday = !!claimed;
    const reward = await this.tierBundle(tier);

    return {
      enabled: cfg.enabled,
      tier,
      alreadyClaimedToday,
      canClaim: cfg.enabled && !alreadyClaimedToday,
      nextResetAt: this.nextResetAt().toISOString(),
      reward,
    };
  }

  // ---- player: claim (single atomic shop-DB transaction) ----
  async claim(user: DailyUser): Promise<DailyClaimResult> {
    const steam = await this.resolveSteam(user);
    const tier = await this.resolveTier(steam);
    const cfg = await this.tierConfigRow(tier);
    if (!cfg.enabled) throw new ForbiddenException('daily_disabled');

    const day = this.dailyDay();
    const items = await this.tierItems(tier, true);
    const goods = items.filter((i) => i.itemId > 0);

    const conn = await this.db.getConnection();
    try {
      await conn.beginTransaction();

      // 1) UNIQUE gate. Inserting the claim row first reserves the day; a dup key means
      //    the caller already claimed today (or a concurrent claim won the race).
      try {
        await conn.query(
          `INSERT INTO ${this.claimsTbl()} (steam_id, claim_date, tier, coins) VALUES (?, ?, ?, ?)`,
          [steam, day, tier, cfg.coins],
        );
      } catch (e: any) {
        await conn.rollback();
        if (e?.code === 'ER_DUP_ENTRY') throw new ConflictException('already_claimed_today');
        throw e;
      }
      const claimId = await this.lastInsertId(conn);

      // 2) Credit coins (sv_coins) — idempotent upsert, same as gacha/vip.
      if (cfg.coins > 0) {
        await conn.query(
          `INSERT INTO ${this.coinsTbl()} (steam_id, balance) VALUES (?, ?)
           ON DUPLICATE KEY UPDATE balance = balance + VALUES(balance)`,
          [steam, cfg.coins],
        );
      }

      // 3) Mint a single 1-use rc_code carrying every item + vehicle in the bundle.
      let redeemCode: string | null = null;
      if (goods.length > 0) {
        const { code, codeId } = await this.purchases.insertNewCode(conn, cfg.codeTtlDays);
        for (const g of goods) {
          const kind: DailyKind = g.kind === 1 ? 1 : 0;
          await conn.query(
            `INSERT INTO ${this.codeItemsTbl()} (code_id, item_id, amount, quality, state, rot, kind)
             VALUES (?, ?, ?, ?, ?, ?, ?)`,
            [codeId, g.itemId, Math.max(1, g.amount), g.quality, '', 0, kind],
          );
        }
        await conn.query(
          `INSERT INTO ${this.codeOwnersTbl()} (code_id, steam_id) VALUES (?, ?)`,
          [codeId, steam],
        );
        await conn.query(
          `UPDATE ${this.claimsTbl()} SET redeem_code = ? WHERE id = ?`, [code, claimId],
        );
        redeemCode = code;
      }

      await conn.commit();

      const toGood = (i: DailyRewardItem): DailyRewardGood => ({
        itemId: i.itemId, amount: i.amount, quality: i.quality,
        label: i.label, imageUrl: i.imageUrl, kind: i.kind,
      });
      return {
        ok: true,
        tier,
        granted: {
          coins: cfg.coins,
          items: goods.filter((g) => g.kind === 0).map(toGood),
          vehicles: goods.filter((g) => g.kind === 1).map(toGood),
        },
        redeemCode,
        nextResetAt: this.nextResetAt().toISOString(),
      };
    } catch (e) {
      try { await conn.rollback(); } catch { /* ignore */ }
      if (e instanceof ConflictException || e instanceof ForbiddenException) throw e;
      this.log.error(`Daily claim failed for ${steam} (tier ${tier}): ${(e as any)?.message}`, (e as any)?.stack);
      throw new ConflictException('delivery_failed');
    } finally {
      conn.release();
    }
  }

  private async lastInsertId(conn: mysql.PoolConnection): Promise<number> {
    const [rows]: any = await conn.query(`SELECT LAST_INSERT_ID() AS id`);
    return Number(rows[0]?.id ?? 0);
  }

  // ---- admin: config ----
  async getAdminConfig(): Promise<DailyAdminConfig> {
    const build = async (tier: DailyTier): Promise<DailyTierAdminView> => {
      const cfg = await this.tierConfigRow(tier);
      const items = await this.tierItems(tier, false);
      return {
        enabled: cfg.enabled,
        coins: cfg.coins,
        codeTtlDays: cfg.codeTtlDays,
        items: items.filter((i) => i.kind === 0),
        vehicles: items.filter((i) => i.kind === 1),
      };
    };
    return { tiers: { normal: await build('normal'), vip: await build('vip') } };
  }

  async updateTierConfig(tier: DailyTier, input: DailyTierConfigInput): Promise<DailyTierAdminView> {
    if (!TIERS.includes(tier)) throw new BadRequestException('invalid_tier');
    const cur = await this.tierConfigRow(tier);
    const enabled = input.enabled ?? cur.enabled;
    const coins = Math.max(0, Math.floor(Number(input.coins ?? cur.coins)));
    const codeTtlDays = clampInt(input.codeTtlDays ?? cur.codeTtlDays, 1, 365);
    await this.db.query(
      `UPDATE ${this.configTbl()} SET enabled = ?, coins = ?, code_ttl_days = ? WHERE tier = ?`,
      [enabled ? 1 : 0, coins, codeTtlDays, tier],
    );
    const view = (await this.getAdminConfig()).tiers[tier];
    return view;
  }

  // ---- admin: items CRUD ----
  async createItem(input: DailyItemInput): Promise<DailyRewardItem> {
    this.validateItem(input, true);
    const kind: DailyKind = input.kind === 1 ? 1 : 0;
    await this.assertInCatalog(Number(input.itemId), kind);
    const res: any = await this.db.query(
      `INSERT INTO ${this.itemsTbl()}
        (tier, item_id, amount, quality, kind, sort, enabled)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [
        input.tier, input.itemId, Math.max(1, Number(input.amount ?? 1)),
        clampInt(input.quality ?? 100, 0, 100), kind, Number(input.sort ?? 0),
        input.enabled === false ? 0 : 1,
      ],
    );
    return this.getItem(Number(res.insertId));
  }

  async updateItem(id: number, input: DailyItemInput): Promise<DailyRewardItem> {
    const existing = await this.db.first<any>(`SELECT * FROM ${this.itemsTbl()} WHERE id = ?`, [id]);
    if (!existing) throw new NotFoundException('item_not_found');
    // Merge against the raw stored row (item_id/kind/etc.), not the catalog-hydrated view.
    const merged = {
      tier: (existing.tier as DailyTier),
      itemId: Number(existing.item_id),
      amount: Number(existing.amount),
      quality: Number(existing.quality),
      kind: (Number(existing.kind) === 1 ? 1 : 0) as DailyKind,
      sort: Number(existing.sort),
      enabled: Number(existing.enabled) === 1,
      ...stripUndefined(input),
    };
    this.validateItem(merged, false);
    await this.assertInCatalog(Number(merged.itemId), merged.kind);
    await this.db.query(
      `UPDATE ${this.itemsTbl()} SET tier = ?, item_id = ?, amount = ?, quality = ?, kind = ?,
         sort = ?, enabled = ? WHERE id = ?`,
      [
        merged.tier, merged.itemId, Math.max(1, Number(merged.amount)),
        clampInt(merged.quality, 0, 100), merged.kind === 1 ? 1 : 0,
        Number(merged.sort), merged.enabled ? 1 : 0, id,
      ],
    );
    return this.getItem(id);
  }

  async deleteItem(id: number): Promise<void> {
    const res: any = await this.db.query(`DELETE FROM ${this.itemsTbl()} WHERE id = ?`, [id]);
    if (!res.affectedRows) throw new NotFoundException('item_not_found');
  }

  private async getItem(id: number): Promise<DailyRewardItem> {
    const row = await this.db.first<any>(`${this.itemsSelectSql('WHERE d.id = ?')}`, [id]);
    if (!row) throw new NotFoundException('item_not_found');
    return this.mapItem(row);
  }

  /** Reject an item_id that isn't present in the catalog matching its kind. */
  private async assertInCatalog(itemId: number, kind: DailyKind) {
    const tbl = kind === 1 ? this.vehicleCatalogTbl() : this.catalogTbl();
    const row = await this.db.first<{ c: number }>(
      `SELECT COUNT(*) AS c FROM ${tbl} WHERE id = ?`, [itemId],
    );
    if (!row || Number(row.c) === 0) throw new BadRequestException('item_not_in_catalog');
  }

  private validateItem(p: { tier?: DailyTier; itemId?: number; kind?: DailyKind }, isCreate: boolean) {
    if (isCreate || p.tier !== undefined) {
      if (!p.tier || !TIERS.includes(p.tier)) throw new BadRequestException('invalid_tier');
    }
    if (isCreate || p.itemId !== undefined) {
      if (!p.itemId || Number(p.itemId) <= 0) throw new BadRequestException('item_id_required');
    }
    if (p.kind !== undefined && p.kind !== 0 && p.kind !== 1) {
      throw new BadRequestException('invalid_kind');
    }
  }
}

function clampInt(v: any, min: number, max: number): number {
  const n = Math.floor(Number(v));
  if (!Number.isFinite(n)) return min;
  return Math.min(max, Math.max(min, n));
}

/** Drop keys whose value is undefined so a partial PATCH-style update keeps existing values. */
function stripUndefined<T extends object>(obj: T): Partial<T> {
  const out: Partial<T> = {};
  for (const k of Object.keys(obj) as (keyof T)[]) {
    if (obj[k] !== undefined) out[k] = obj[k];
  }
  return out;
}
