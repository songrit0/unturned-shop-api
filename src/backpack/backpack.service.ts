import {
  BadRequestException, ForbiddenException, Injectable, Logger, NotFoundException, OnModuleInit,
} from '@nestjs/common';
import { DbService } from '../database/db.service';
import { MeowcoinWalletService } from '../topup/meowcoin-wallet.service';
import { Paginated, normalizePage } from '../common/pagination';

export type BackpackPayMethod = 'coins' | 'meowcoins' | 'mixed';

export interface BackpackUpgradeConfig {
  enabled: boolean;
  vip_only: boolean;
  base_coins: number;
  base_meowcoins: number;      // 0 = Meowcoin payment disabled
  mixed_enabled: boolean;
  default_height: number;      // must match the VaultBackpack plugin's DefaultHeight
  max_height: number;
}

export interface BackpackNextCost {
  coins: number;
  meowcoins: number | null;                                  // null = meow not available
  mixed: { coins: number; meowcoins: number } | null;        // null = mixed not available
}

export interface BackpackMe {
  enabled: boolean;
  vip_only: boolean;
  is_vip: boolean;
  can_upgrade: boolean;
  width: number;
  height: number;
  level: number;
  max_level: number;
  at_max: boolean;
  next: BackpackNextCost | null;   // null when at max
}

/**
 * Web-side upgrades for the in-game VaultBackpack plugin. The plugin stores the
 * per-player size in sv_vault_players (width, height); level = height - default_height + 1.
 * The plugin only writes items_data on vault close, so bumping height here never
 * conflicts with an open in-game session (the player just reopens to see the new size).
 *
 * Costs scale with the CURRENT level (same rule as the in-game /bpu command):
 *   coins  = base_coins * level
 *   meow   = base_meowcoins * level
 *   mixed  = ceil(coins/2) + ceil(meow/2)   // "average": pay half of each side
 */
@Injectable()
export class BackpackService implements OnModuleInit {
  private readonly log = new Logger(BackpackService.name);

  constructor(
    private readonly db: DbService,
    private readonly wallet: MeowcoinWalletService,
  ) {}

  private cfgT() { return this.db.table('sv', 'backpack_upgrade_config'); }
  private vaultT() { return this.db.table('sv', 'vault_players'); }
  private coinsT() { return this.db.table('sv', 'coins'); }
  private grantsT() { return this.db.table('sv', 'vip_grants'); }
  private activityT() { return this.db.table('sv', 'activity_log'); }
  private linksT() { return this.db.table('sv', 'links'); }

  async onModuleInit() {
    try {
      await this.db.query(
        `CREATE TABLE IF NOT EXISTS ${this.cfgT()} (
          id TINYINT UNSIGNED NOT NULL,
          enabled TINYINT(1) NOT NULL DEFAULT 1,
          vip_only TINYINT(1) NOT NULL DEFAULT 1,
          base_coins BIGINT NOT NULL DEFAULT 500,
          base_meowcoins BIGINT NOT NULL DEFAULT 0,
          mixed_enabled TINYINT(1) NOT NULL DEFAULT 1,
          default_height INT NOT NULL DEFAULT 5,
          max_height INT NOT NULL DEFAULT 15,
          updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
          PRIMARY KEY (id)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
      );
      await this.db.query(`INSERT IGNORE INTO ${this.cfgT()} (id) VALUES (1)`);
      this.log.log('Backpack upgrade config table ready');
    } catch (e: any) {
      this.log.warn(`Backpack ensureSchema failed: ${e.message}`);
    }
  }

  // ---- config ----
  async getConfig(): Promise<BackpackUpgradeConfig> {
    const r = await this.db.first<any>(`SELECT * FROM ${this.cfgT()} WHERE id = 1`);
    return {
      enabled: Number(r?.enabled ?? 1) === 1,
      vip_only: Number(r?.vip_only ?? 1) === 1,
      base_coins: Number(r?.base_coins ?? 500),
      base_meowcoins: Number(r?.base_meowcoins ?? 0),
      mixed_enabled: Number(r?.mixed_enabled ?? 1) === 1,
      default_height: Number(r?.default_height ?? 5),
      max_height: Number(r?.max_height ?? 15),
    };
  }

  async updateConfig(input: Partial<BackpackUpgradeConfig>): Promise<BackpackUpgradeConfig> {
    const cur = await this.getConfig();
    const next = { ...cur, ...input };
    if (!(next.base_coins >= 0) || !(next.base_meowcoins >= 0)) throw new BadRequestException('invalid_price');
    if (next.default_height < 1 || next.max_height < next.default_height) throw new BadRequestException('invalid_height');
    await this.db.query(
      `UPDATE ${this.cfgT()} SET enabled=?, vip_only=?, base_coins=?, base_meowcoins=?,
         mixed_enabled=?, default_height=?, max_height=? WHERE id = 1`,
      [
        next.enabled ? 1 : 0, next.vip_only ? 1 : 0,
        Math.trunc(next.base_coins), Math.trunc(next.base_meowcoins),
        next.mixed_enabled ? 1 : 0, Math.trunc(next.default_height), Math.trunc(next.max_height),
      ],
    );
    return this.getConfig();
  }

  // ---- helpers ----
  private levelOf(height: number, cfg: BackpackUpgradeConfig): number {
    return Math.max(1, height - cfg.default_height + 1);
  }

  private nextCost(level: number, cfg: BackpackUpgradeConfig): BackpackNextCost {
    const coins = cfg.base_coins * level;
    const meow = cfg.base_meowcoins > 0 ? cfg.base_meowcoins * level : null;
    const mixed = cfg.mixed_enabled && meow != null
      ? { coins: Math.ceil(coins / 2), meowcoins: Math.ceil(meow / 2) }
      : null;
    return { coins, meowcoins: meow, mixed };
  }

  async isVip(steamId: string): Promise<boolean> {
    const row = await this.db.first<{ c: number }>(
      `SELECT COUNT(*) AS c FROM ${this.grantsT()}
       WHERE steam_id = ? AND active = 1 AND expires_at > UTC_TIMESTAMP()`,
      [steamId],
    );
    return !!row && Number(row.c) > 0;
  }

  private async vaultRow(steamId: string): Promise<{ width: number; height: number }> {
    const r = await this.db.first<any>(
      `SELECT width, height FROM ${this.vaultT()} WHERE steam_id = ?`, [steamId],
    );
    if (r) return { width: Number(r.width), height: Number(r.height) };
    const cfg = await this.getConfig();
    return { width: 5, height: cfg.default_height }; // no row yet — plugin defaults
  }

  // ---- player: status ----
  async me(steamId: string): Promise<BackpackMe> {
    const cfg = await this.getConfig();
    const vip = await this.isVip(steamId);
    const { width, height } = await this.vaultRow(steamId);
    const level = this.levelOf(height, cfg);
    const maxLevel = this.levelOf(cfg.max_height, cfg);
    const atMax = height >= cfg.max_height;
    return {
      enabled: cfg.enabled,
      vip_only: cfg.vip_only,
      is_vip: vip,
      can_upgrade: cfg.enabled && !atMax && (!cfg.vip_only || vip),
      width, height, level,
      max_level: maxLevel,
      at_max: atMax,
      next: atMax ? null : this.nextCost(level, cfg),
    };
  }

  // ---- player: upgrade ----
  /**
   * Charge + height+1. Coins deduct and the height bump share one shop-DB txn.
   * Meowcoin lives in the separate top-up DB, so meow/mixed run the same SAGA as
   * VipService.buyMeowcoin: keep shop txn open -> wallet.debit -> commit -> refund on commit failure.
   */
  async upgrade(steamId: string, method: BackpackPayMethod) {
    const cfg = await this.getConfig();
    if (!cfg.enabled) throw new BadRequestException('backpack_upgrade_disabled');
    if (cfg.vip_only && !(await this.isVip(steamId))) throw new ForbiddenException('vip_required');

    const conn = await this.db.getConnection();
    let committed = false;
    let meowCharged = 0;
    const refKey = `bp:${steamId}`;
    try {
      await conn.beginTransaction();

      // Ensure + lock the vault row (table defaults 5x5 match the plugin defaults).
      await conn.query(`INSERT IGNORE INTO ${this.vaultT()} (steam_id) VALUES (?)`, [steamId]);
      const [vRows] = await conn.query(
        `SELECT width, height FROM ${this.vaultT()} WHERE steam_id = ? FOR UPDATE`, [steamId],
      );
      const height = Number((vRows as any[])[0].height);
      if (height >= cfg.max_height) { await conn.rollback(); throw new BadRequestException('max_level'); }

      const level = this.levelOf(height, cfg);
      const cost = this.nextCost(level, cfg);

      let coinCost = 0;
      let meowCost = 0;
      if (method === 'coins') {
        coinCost = cost.coins;
      } else if (method === 'meowcoins') {
        if (cost.meowcoins == null) { await conn.rollback(); throw new BadRequestException('meowcoin_not_available'); }
        meowCost = cost.meowcoins;
      } else if (method === 'mixed') {
        if (cost.mixed == null) { await conn.rollback(); throw new BadRequestException('mixed_not_available'); }
        coinCost = cost.mixed.coins;
        meowCost = cost.mixed.meowcoins;
      } else {
        await conn.rollback(); throw new BadRequestException('invalid_method');
      }

      if (coinCost > 0) {
        await conn.query(
          `INSERT INTO ${this.coinsT()} (steam_id, balance) VALUES (?, 0) ON DUPLICATE KEY UPDATE balance = balance`,
          [steamId],
        );
        const [res] = await conn.query(
          `UPDATE ${this.coinsT()} SET balance = balance - ? WHERE steam_id = ? AND balance >= ?`,
          [coinCost, steamId, coinCost],
        );
        if (Number((res as any).affectedRows) === 0) {
          await conn.rollback();
          throw new BadRequestException('insufficient_coins');
        }
        await conn.query(
          `INSERT INTO ${this.activityT()} (steam_id, kind, coins) VALUES (?, 'bp_upgrade', ?)`,
          [steamId, -coinCost],
        );
      }

      await conn.query(`UPDATE ${this.vaultT()} SET height = height + 1 WHERE steam_id = ?`, [steamId]);

      if (meowCost > 0) {
        try {
          await this.wallet.debit(steamId, meowCost, 'backpack_upgrade', refKey);
          meowCharged = meowCost;
        } catch (e: any) {
          await conn.rollback();
          if (e?.response?.message === 'insufficient_meowcoin' || e?.message === 'insufficient_meowcoin') {
            throw new BadRequestException('insufficient_meowcoin');
          }
          throw e;
        }
      }

      try {
        await conn.commit();
        committed = true;
      } catch (commitErr) {
        if (meowCharged > 0) {
          await this.wallet.refund(steamId, meowCharged, 'backpack_upgrade_refund', refKey).catch(() => {});
        }
        throw commitErr;
      }

      return {
        ok: true as const,
        method,
        paid: { coins: coinCost, meowcoins: meowCost },
        ...(await this.me(steamId)),
      };
    } catch (e) {
      if (!committed) { try { await conn.rollback(); } catch {} }
      throw e;
    } finally {
      conn.release();
    }
  }

  // ---- admin: players ----
  async listPlayers(search: string | undefined, page?: number, limit?: number): Promise<Paginated<any>> {
    const np = normalizePage(page, limit);
    const where = search ? `WHERE v.steam_id LIKE ?` : '';
    const params = search ? [`%${search}%`] : [];
    const cnt = await this.db.first<{ c: number }>(
      `SELECT COUNT(*) AS c FROM ${this.vaultT()} v ${where}`, params,
    );
    const total = cnt ? Number(cnt.c) : 0;
    const items = await this.db.query<any>(
      `SELECT v.steam_id, v.width, v.height, v.updated_at,
              COALESCE(l.discord_global_name, l.discord_username) AS discord_name
       FROM ${this.vaultT()} v
       LEFT JOIN ${this.linksT()} l ON l.steam_id = v.steam_id
       ${where}
       ORDER BY v.updated_at DESC
       LIMIT ${np.limit} OFFSET ${(np.page - 1) * np.limit}`,
      params,
    );
    const cfg = await this.getConfig();
    return {
      items: items.map((r) => ({
        steam_id: String(r.steam_id),
        discord_name: r.discord_name ?? null,
        width: Number(r.width),
        height: Number(r.height),
        level: this.levelOf(Number(r.height), cfg),
        updated_at: r.updated_at,
      })),
      total, page: np.page, limit: np.limit, pages: Math.ceil(total / np.limit),
    };
  }

  async setPlayerSize(steamId: string, width: number, height: number) {
    const w = Math.trunc(Number(width));
    const h = Math.trunc(Number(height));
    if (!(w >= 1 && w <= 10) || !(h >= 1 && h <= 200)) throw new BadRequestException('invalid_size');
    const res: any = await this.db.query(
      `INSERT INTO ${this.vaultT()} (steam_id, width, height) VALUES (?, ?, ?)
       ON DUPLICATE KEY UPDATE width = VALUES(width), height = VALUES(height)`,
      [steamId, w, h],
    );
    if (!res) throw new NotFoundException();
    const cfg = await this.getConfig();
    return { steam_id: steamId, width: w, height: h, level: this.levelOf(h, cfg) };
  }
}
