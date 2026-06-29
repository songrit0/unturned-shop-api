import {
  BadRequestException, ConflictException, ForbiddenException,
  Injectable, Logger, NotFoundException, OnModuleInit,
} from '@nestjs/common';
import { DbService } from '../database/db.service';
import { UsersService } from '../users/users.service';
import { PurchasesService } from '../purchases/purchases.service';
import { MeowcoinWalletService } from '../topup/meowcoin-wallet.service';
import { PlayerStatsService } from '../player-stats/player-stats.service';
import {
  GachaConfig, GachaPrize, GachaPrizeType, GachaSpinResult, GachaState, GachaTodayEntry,
} from './gacha.types';

const THAI_OFFSET_MS = 7 * 60 * 60 * 1000;
const RESET_HOUR = 6; // daily reset at 06:00 Thai (aligned with the scheduled restart)

/** Minimal slice of the JWT payload the gacha needs to identify + classify the caller. */
type GachaUser = { steam_id: string | null; sub: string | null; is_admin?: boolean };

@Injectable()
export class GachaService implements OnModuleInit {
  private readonly log = new Logger(GachaService.name);

  constructor(
    private readonly db: DbService,
    private readonly users: UsersService,
    private readonly purchases: PurchasesService,
    private readonly meow: MeowcoinWalletService,
    private readonly playerStats: PlayerStatsService,
  ) {}

  // ---- table refs ----
  private prizesTbl() { return this.db.table('sv', 'gacha_prizes'); }
  private drawsTbl() { return this.db.table('sv', 'gacha_draws'); }
  private stateTbl() { return this.db.table('sv', 'gacha_spin_state'); }
  private walletTbl() { return this.db.table('sv', 'gacha_wallet'); }
  private configTbl() { return this.db.table('sv', 'gacha_config'); }
  private vipPackagesTbl() { return this.db.table('sv', 'vip_packages'); }
  private coinsTbl() { return this.db.table('sv', 'coins'); }
  private codeItemsTbl() { return this.db.table('rc', 'code_items'); }
  private codeOwnersTbl() { return this.db.table('sv', 'code_owners'); }

  async onModuleInit() {
    try {
      await this.db.query(
        `CREATE TABLE IF NOT EXISTS ${this.prizesTbl()} (
          id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
          type ENUM('coins','meowcoins','item','vehicle','vip') NOT NULL,
          ref_id INT NULL,
          amount BIGINT NOT NULL DEFAULT 0,
          quality TINYINT UNSIGNED NOT NULL DEFAULT 100,
          weight DOUBLE NOT NULL DEFAULT 1,
          label VARCHAR(128) NULL,
          image_url VARCHAR(512) NULL,
          rarity VARCHAR(16) NULL,
          enabled TINYINT(1) NOT NULL DEFAULT 1,
          sort INT NOT NULL DEFAULT 0,
          created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
          PRIMARY KEY (id),
          INDEX idx_enabled (enabled)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
      );
      await this.db.query(
        `CREATE TABLE IF NOT EXISTS ${this.drawsTbl()} (
          id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
          steam_id CHAR(17) NOT NULL,
          prize_id BIGINT UNSIGNED NULL,
          prize_type VARCHAR(16) NOT NULL,
          prize_label VARCHAR(128) NOT NULL,
          prize_amount BIGINT NOT NULL DEFAULT 0,
          prize_image_url VARCHAR(512) NULL,
          rarity VARCHAR(16) NULL,
          code VARCHAR(64) NULL,
          gacha_day VARCHAR(10) NOT NULL,
          created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
          PRIMARY KEY (id),
          INDEX idx_day (gacha_day, created_at),
          INDEX idx_steam (steam_id)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
      );
      await this.db.query(
        `CREATE TABLE IF NOT EXISTS ${this.stateTbl()} (
          steam_id CHAR(17) NOT NULL,
          gacha_day VARCHAR(10) NOT NULL,
          free_used INT NOT NULL DEFAULT 0,
          PRIMARY KEY (steam_id, gacha_day)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
      );
      await this.db.query(
        `CREATE TABLE IF NOT EXISTS ${this.walletTbl()} (
          steam_id CHAR(17) NOT NULL,
          paid_spins INT NOT NULL DEFAULT 0,
          updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
          PRIMARY KEY (steam_id)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
      );
      await this.db.query(
        `CREATE TABLE IF NOT EXISTS ${this.configTbl()} (
          id TINYINT NOT NULL DEFAULT 1,
          enabled TINYINT(1) NOT NULL DEFAULT 1,
          base_free_spins INT NOT NULL DEFAULT 0,
          rank_bonus JSON NULL,
          price_coins BIGINT NULL,
          price_meowcoins BIGINT NULL,
          code_ttl_days INT NOT NULL DEFAULT 30,
          updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
          PRIMARY KEY (id)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
      );
      // Seed the single config row with sensible defaults if absent.
      await this.db.query(
        `INSERT IGNORE INTO ${this.configTbl()}
          (id, enabled, base_free_spins, rank_bonus, price_coins, price_meowcoins, code_ttl_days)
         VALUES (1, 1, 0, ?, NULL, NULL, 30)`,
        [JSON.stringify({ '1': 3, '2': 2, '3': 1 })],
      );
      this.log.log('Gacha tables ready');
    } catch (e: any) {
      this.log.warn(`Gacha ensureSchema failed: ${e.message}`);
    }
  }

  // ---- time helpers ----
  /** Current gacha-day key (YYYY-MM-DD), rolling over at 06:00 Thai. */
  gachaDay(nowMs: number = Date.now()): string {
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

  // ---- identity ----
  private async resolveSteam(user: GachaUser): Promise<string> {
    const steam = user.steam_id ?? (await this.users.findSteamByDiscord(user.sub));
    if (!steam) throw new ForbiddenException('not_linked');
    return steam;
  }

  // ---- config ----
  async getConfig(): Promise<GachaConfig> {
    const row = await this.db.first<any>(`SELECT * FROM ${this.configTbl()} WHERE id = 1`);
    return this.mapConfig(row);
  }

  private mapConfig(row: any): GachaConfig {
    let rankBonus: Record<string, number> = { '1': 3, '2': 2, '3': 1 };
    if (row?.rank_bonus) {
      try {
        rankBonus = typeof row.rank_bonus === 'string' ? JSON.parse(row.rank_bonus) : row.rank_bonus;
      } catch { /* keep default */ }
    }
    return {
      enabled: row ? Number(row.enabled) === 1 : true,
      base_free_spins: Number(row?.base_free_spins ?? 0),
      rank_bonus: rankBonus,
      price_coins: row?.price_coins == null ? null : Number(row.price_coins),
      price_meowcoins: row?.price_meowcoins == null ? null : Number(row.price_meowcoins),
      code_ttl_days: Number(row?.code_ttl_days ?? 30),
    };
  }

  async updateConfig(input: Partial<GachaConfig>): Promise<GachaConfig> {
    const cur = await this.getConfig();
    const next: GachaConfig = {
      enabled: input.enabled ?? cur.enabled,
      base_free_spins: clampInt(input.base_free_spins ?? cur.base_free_spins, 0, 100),
      rank_bonus: input.rank_bonus ?? cur.rank_bonus,
      price_coins: normPrice(input.price_coins, cur.price_coins),
      price_meowcoins: normPrice(input.price_meowcoins, cur.price_meowcoins),
      code_ttl_days: clampInt(input.code_ttl_days ?? cur.code_ttl_days, 1, 365),
    };
    await this.db.query(
      `UPDATE ${this.configTbl()} SET enabled=?, base_free_spins=?, rank_bonus=?,
         price_coins=?, price_meowcoins=?, code_ttl_days=? WHERE id=1`,
      [
        next.enabled ? 1 : 0, next.base_free_spins, JSON.stringify(next.rank_bonus),
        next.price_coins, next.price_meowcoins, next.code_ttl_days,
      ],
    );
    return next;
  }

  // ---- prizes (admin) ----
  async listPrizes(): Promise<GachaPrize[]> {
    const rows = await this.db.query<any>(
      `SELECT * FROM ${this.prizesTbl()} ORDER BY sort ASC, id ASC`,
    );
    return rows.map((r) => this.mapPrize(r));
  }

  async listActivePrizes(): Promise<GachaPrize[]> {
    const rows = await this.db.query<any>(
      `SELECT * FROM ${this.prizesTbl()} WHERE enabled = 1 AND weight > 0 ORDER BY sort ASC, id ASC`,
    );
    return rows.map((r) => this.mapPrize(r));
  }

  /** Who currently earns free spins by leaderboard rank (Top-N), plus the next reset time.
   *  Drives the home "rank rewards" card. */
  async rankRewards(): Promise<{
    enabled: boolean;
    nextResetAt: string;
    entries: Array<{ rank: number; name: string; kills: number; spins: number }>;
  }> {
    const cfg = await this.getConfig();
    const nextResetAt = this.nextResetAt().toISOString();
    const ranks = Object.entries(cfg.rank_bonus || {})
      .map(([r, s]) => ({ rank: Number(r), spins: Number(s) }))
      .filter((x) => x.rank > 0 && x.spins > 0)
      .sort((a, b) => a.rank - b.rank);
    if (ranks.length === 0) return { enabled: cfg.enabled, nextResetAt, entries: [] };

    const maxRank = Math.max(...ranks.map((r) => r.rank));
    const spinByRank = new Map(ranks.map((r) => [r.rank, r.spins]));
    let board: Array<{ name: string; kills: number }> = [];
    try {
      board = await this.playerStats.leaderboard(maxRank);
    } catch {
      board = [];
    }
    const entries = board
      .map((p, i) => {
        const rank = i + 1;
        const spins = spinByRank.get(rank) ?? 0;
        return spins > 0 ? { rank, name: p.name, kills: p.kills, spins } : null;
      })
      .filter((x): x is { rank: number; name: string; kills: number; spins: number } => x !== null);
    return { enabled: cfg.enabled, nextResetAt, entries };
  }

  /** Display-only pool for the spin reel (no weights leaked). */
  async displayPool(): Promise<Array<{ type: GachaPrizeType; label: string; amount: number; imageUrl: string | null; rarity: string | null }>> {
    const prizes = await this.listActivePrizes();
    return prizes.map((p) => ({
      type: p.type,
      label: this.prizeLabel(p),
      amount: p.amount,
      imageUrl: p.image_url,
      rarity: p.rarity,
    }));
  }

  private mapPrize(r: any): GachaPrize {
    return {
      id: Number(r.id),
      type: r.type,
      ref_id: r.ref_id == null ? null : Number(r.ref_id),
      amount: Number(r.amount),
      quality: Number(r.quality),
      weight: Number(r.weight),
      label: r.label ?? null,
      image_url: r.image_url ?? null,
      rarity: r.rarity ?? null,
      enabled: Number(r.enabled) === 1,
      sort: Number(r.sort),
    };
  }

  async createPrize(input: Partial<GachaPrize>): Promise<GachaPrize> {
    this.validatePrize(input);
    const res: any = await this.db.query(
      `INSERT INTO ${this.prizesTbl()}
        (type, ref_id, amount, quality, weight, label, image_url, rarity, enabled, sort)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        input.type, input.ref_id ?? null, Math.max(0, Number(input.amount ?? 0)),
        clampInt(input.quality ?? 100, 0, 100), Math.max(0, Number(input.weight ?? 1)),
        input.label ?? null, input.image_url ?? null, input.rarity ?? null,
        input.enabled === false ? 0 : 1, Number(input.sort ?? 0),
      ],
    );
    const id = Number(res.insertId);
    const row = await this.db.first<any>(`SELECT * FROM ${this.prizesTbl()} WHERE id = ?`, [id]);
    return this.mapPrize(row);
  }

  async updatePrize(id: number, input: Partial<GachaPrize>): Promise<GachaPrize> {
    const existing = await this.db.first<any>(`SELECT * FROM ${this.prizesTbl()} WHERE id = ?`, [id]);
    if (!existing) throw new NotFoundException('prize_not_found');
    const merged = { ...this.mapPrize(existing), ...input };
    this.validatePrize(merged);
    await this.db.query(
      `UPDATE ${this.prizesTbl()} SET type=?, ref_id=?, amount=?, quality=?, weight=?,
         label=?, image_url=?, rarity=?, enabled=?, sort=? WHERE id=?`,
      [
        merged.type, merged.ref_id ?? null, Math.max(0, Number(merged.amount)),
        clampInt(merged.quality, 0, 100), Math.max(0, Number(merged.weight)),
        merged.label ?? null, merged.image_url ?? null, merged.rarity ?? null,
        merged.enabled ? 1 : 0, Number(merged.sort), id,
      ],
    );
    const row = await this.db.first<any>(`SELECT * FROM ${this.prizesTbl()} WHERE id = ?`, [id]);
    return this.mapPrize(row);
  }

  async deletePrize(id: number): Promise<void> {
    const res: any = await this.db.query(`DELETE FROM ${this.prizesTbl()} WHERE id = ?`, [id]);
    if (!res.affectedRows) throw new NotFoundException('prize_not_found');
  }

  private validatePrize(p: Partial<GachaPrize>) {
    const types: GachaPrizeType[] = ['coins', 'meowcoins', 'item', 'vehicle', 'vip'];
    if (!p.type || !types.includes(p.type)) throw new BadRequestException('invalid_type');
    if ((p.type === 'item' || p.type === 'vehicle' || p.type === 'vip') && !p.ref_id) {
      throw new BadRequestException('ref_id_required');
    }
    if ((p.type === 'coins' || p.type === 'meowcoins') && Number(p.amount) <= 0) {
      throw new BadRequestException('amount_required');
    }
  }

  // ---- player state ----
  async state(user: GachaUser): Promise<GachaState> {
    const steam = await this.resolveSteam(user);
    const cfg = await this.getConfig();
    const day = this.gachaDay();
    const rank = await this.effectiveRank(user, steam);
    const freeEntitlement = this.freeEntitlement(cfg, rank);
    const st = await this.db.first<{ free_used: number }>(
      `SELECT free_used FROM ${this.stateTbl()} WHERE steam_id = ? AND gacha_day = ?`,
      [steam, day],
    );
    const freeUsed = Number(st?.free_used ?? 0);
    const freeRemaining = Math.max(0, freeEntitlement - freeUsed);
    const wallet = await this.db.first<{ paid_spins: number }>(
      `SELECT paid_spins FROM ${this.walletTbl()} WHERE steam_id = ?`, [steam],
    );
    const paidSpins = Number(wallet?.paid_spins ?? 0);
    return {
      enabled: cfg.enabled,
      rank,
      freeEntitlement,
      freeUsed,
      freeRemaining,
      paidSpins,
      totalRemaining: freeRemaining + paidSpins,
      priceCoins: cfg.price_coins,
      priceMeowcoins: cfg.price_meowcoins,
      nextResetAt: this.nextResetAt().toISOString(),
    };
  }

  /** Effective leaderboard rank for free-spin purposes. Admins are excluded from the
   *  top-player free spins entirely (they get only base_free_spins). */
  private async effectiveRank(user: GachaUser, steam: string): Promise<number | null> {
    if (user?.is_admin) return null;
    return this.rankOf(steam);
  }

  /** 1-based leaderboard rank by Kills, or null if the player has no (eligible) PlayerStats row.
   *  NULL Kills are treated as 0 so a player with a NULL/empty row can't appear as rank 1. */
  private async rankOf(steam: string): Promise<number | null> {
    try {
      // Must have an eligible (non-disabled) row to be ranked at all.
      const self = await this.db.first<{ kills: number | null }>(
        `SELECT COALESCE(Kills, 0) AS kills FROM \`PlayerStats\`
         WHERE SteamId = ? AND (UIDisabled IS NULL OR UIDisabled = 0)`,
        [steam],
      );
      if (!self) return null;
      const myKills = Number(self.kills ?? 0);
      const row = await this.db.first<{ rnk: number }>(
        `SELECT COUNT(*) + 1 AS rnk FROM \`PlayerStats\` p
         WHERE (p.UIDisabled IS NULL OR p.UIDisabled = 0)
           AND COALESCE(p.Kills, 0) > ?`,
        [myKills],
      );
      return row ? Number(row.rnk) : null;
    } catch {
      return null;
    }
  }

  private freeEntitlement(cfg: GachaConfig, rank: number | null): number {
    let n = cfg.base_free_spins;
    if (rank != null) n += Number(cfg.rank_bonus?.[String(rank)] ?? 0);
    return Math.max(0, n);
  }

  // ---- buy spins ----
  async buy(
    user: GachaUser,
    count: number, currency: 'coins' | 'meowcoins',
  ): Promise<{ paidSpins: number; charged: number; currency: string }> {
    const steam = await this.resolveSteam(user);
    const cfg = await this.getConfig();
    const n = clampInt(count, 1, 50);
    const unit = currency === 'coins' ? cfg.price_coins : cfg.price_meowcoins;
    if (unit == null || unit <= 0) throw new BadRequestException('buy_currency_disabled');
    const cost = unit * n;

    if (currency === 'meowcoins') {
      // Separate Pi5 wallet — debit there (throws insufficient_meowcoin), then add spins on the shop DB.
      await this.meow.debit(steam, cost, 'gacha_buy_spins', null);
      await this.addPaidSpins(steam, n);
    } else {
      // Coins live on the shop DB — charge + grant spins in one transaction.
      const conn = await this.db.getConnection();
      try {
        await conn.beginTransaction();
        await conn.query(
          `INSERT INTO ${this.coinsTbl()} (steam_id, balance) VALUES (?, 0)
           ON DUPLICATE KEY UPDATE balance = balance`, [steam],
        );
        const [res]: any = await conn.query(
          `UPDATE ${this.coinsTbl()} SET balance = balance - ? WHERE steam_id = ? AND balance >= ?`,
          [cost, steam, cost],
        );
        if (!res.affectedRows) { await conn.rollback(); throw new BadRequestException('insufficient_coins'); }
        await conn.query(
          `INSERT INTO ${this.walletTbl()} (steam_id, paid_spins) VALUES (?, ?)
           ON DUPLICATE KEY UPDATE paid_spins = paid_spins + VALUES(paid_spins)`,
          [steam, n],
        );
        await conn.commit();
      } catch (e) {
        try { await conn.rollback(); } catch { /* ignore */ }
        throw e;
      } finally {
        conn.release();
      }
    }
    const wallet = await this.db.first<{ paid_spins: number }>(
      `SELECT paid_spins FROM ${this.walletTbl()} WHERE steam_id = ?`, [steam],
    );
    return { paidSpins: Number(wallet?.paid_spins ?? 0), charged: cost, currency };
  }

  private async addPaidSpins(steam: string, n: number) {
    await this.db.query(
      `INSERT INTO ${this.walletTbl()} (steam_id, paid_spins) VALUES (?, ?)
       ON DUPLICATE KEY UPDATE paid_spins = paid_spins + VALUES(paid_spins)`,
      [steam, n],
    );
  }

  // ---- spin ----
  async spin(user: GachaUser): Promise<GachaSpinResult> {
    const steam = await this.resolveSteam(user);
    const cfg = await this.getConfig();
    if (!cfg.enabled) throw new ForbiddenException('gacha_disabled');

    const prizes = await this.listActivePrizes();
    if (prizes.length === 0) throw new ConflictException('no_prizes_configured');

    const day = this.gachaDay();
    const rank = await this.effectiveRank(user, steam);
    const freeEntitlement = this.freeEntitlement(cfg, rank);

    // Consume a spin: free first (bounded by entitlement), else a persistent paid spin.
    const usedFree = await this.tryConsumeFree(steam, day, freeEntitlement);
    if (!usedFree) {
      const usedPaid = await this.tryConsumePaid(steam);
      if (!usedPaid) throw new ConflictException('no_spins');
    }

    // Weighted random pick.
    const prize = this.pickWeighted(prizes);

    // Deliver + record. Refund the spin if delivery fails so the player isn't charged for nothing.
    try {
      const code = await this.deliver(steam, prize, cfg);
      await this.recordDraw(steam, prize, code, day);
      const remaining = await this.remainingSpins(steam, day, freeEntitlement);
      return {
        prize: {
          type: prize.type,
          label: this.prizeLabel(prize),
          amount: prize.amount,
          imageUrl: prize.image_url,
          rarity: prize.rarity,
          code,
        },
        remaining,
      };
    } catch (e: any) {
      try { await this.refundSpin(steam, day, usedFree); } catch { /* best-effort refund */ }
      this.log.error(
        `Gacha deliver failed for ${steam} (prize #${prize.id} ${prize.type} ref=${prize.ref_id}): ${e?.message}`,
        e?.stack,
      );
      throw new ConflictException('delivery_failed');
    }
  }

  /** Atomically increment free_used if still under entitlement. Returns true if a free spin was taken. */
  private async tryConsumeFree(steam: string, day: string, entitlement: number): Promise<boolean> {
    if (entitlement <= 0) return false;
    await this.db.query(
      `INSERT INTO ${this.stateTbl()} (steam_id, gacha_day, free_used) VALUES (?, ?, 0)
       ON DUPLICATE KEY UPDATE free_used = free_used`,
      [steam, day],
    );
    // NOTE: db.query() returns the driver result directly (ResultSetHeader for writes), NOT a
    // [rows, fields] tuple — do not array-destructure it.
    const res: any = await this.db.query(
      `UPDATE ${this.stateTbl()} SET free_used = free_used + 1
       WHERE steam_id = ? AND gacha_day = ? AND free_used < ?`,
      [steam, day, entitlement],
    );
    return Number(res?.affectedRows ?? 0) > 0;
  }

  private async tryConsumePaid(steam: string): Promise<boolean> {
    const res: any = await this.db.query(
      `UPDATE ${this.walletTbl()} SET paid_spins = paid_spins - 1
       WHERE steam_id = ? AND paid_spins > 0`, [steam],
    );
    return Number(res?.affectedRows ?? 0) > 0;
  }

  private async refundSpin(steam: string, day: string, wasFree: boolean) {
    if (wasFree) {
      await this.db.query(
        `UPDATE ${this.stateTbl()} SET free_used = GREATEST(0, free_used - 1)
         WHERE steam_id = ? AND gacha_day = ?`, [steam, day],
      );
    } else {
      await this.addPaidSpins(steam, 1);
    }
  }

  private async remainingSpins(steam: string, day: string, entitlement: number): Promise<number> {
    const st = await this.db.first<{ free_used: number }>(
      `SELECT free_used FROM ${this.stateTbl()} WHERE steam_id = ? AND gacha_day = ?`, [steam, day],
    );
    const wallet = await this.db.first<{ paid_spins: number }>(
      `SELECT paid_spins FROM ${this.walletTbl()} WHERE steam_id = ?`, [steam],
    );
    const freeRemaining = Math.max(0, entitlement - Number(st?.free_used ?? 0));
    return freeRemaining + Number(wallet?.paid_spins ?? 0);
  }

  private pickWeighted(prizes: GachaPrize[]): GachaPrize {
    const total = prizes.reduce((s, p) => s + Math.max(0, p.weight), 0);
    let roll = Math.random() * total;
    for (const p of prizes) {
      roll -= Math.max(0, p.weight);
      if (roll < 0) return p;
    }
    return prizes[prizes.length - 1];
  }

  /** Grant the prize. Returns a redeem code for item/vehicle prizes, else null. */
  private async deliver(steam: string, prize: GachaPrize, cfg: GachaConfig): Promise<string | null> {
    switch (prize.type) {
      case 'coins': {
        await this.db.query(
          `INSERT INTO ${this.coinsTbl()} (steam_id, balance) VALUES (?, ?)
           ON DUPLICATE KEY UPDATE balance = balance + VALUES(balance)`,
          [steam, prize.amount],
        );
        return null;
      }
      case 'meowcoins': {
        await this.meow.refund(steam, prize.amount, 'gacha_prize', null);
        return null;
      }
      case 'item':
      case 'vehicle': {
        const kind = prize.type === 'vehicle' ? 1 : 0;
        const conn = await this.db.getConnection();
        try {
          await conn.beginTransaction();
          const { code, codeId } = await this.purchases.insertNewCode(conn, cfg.code_ttl_days);
          await conn.query(
            `INSERT INTO ${this.codeItemsTbl()} (code_id, item_id, amount, quality, state, rot, kind)
             VALUES (?, ?, ?, ?, ?, ?, ?)`,
            [codeId, prize.ref_id, Math.max(1, prize.amount), prize.quality, '', 0, kind],
          );
          await conn.query(
            `INSERT INTO ${this.codeOwnersTbl()} (code_id, steam_id) VALUES (?, ?)`,
            [codeId, steam],
          );
          await conn.commit();
          return code;
        } catch (e) {
          try { await conn.rollback(); } catch { /* ignore */ }
          throw e;
        } finally {
          conn.release();
        }
      }
      case 'vip': {
        const pkg = await this.db.first<{ group_id: string; days: number }>(
          `SELECT group_id, days FROM ${this.vipPackagesTbl()} WHERE id = ?`, [prize.ref_id],
        );
        if (!pkg) throw new NotFoundException('vip_package_not_found');
        const days = prize.amount > 0 ? prize.amount : Number(pkg.days);
        await this.db.query(
          `INSERT INTO ${this.db.table('sv', 'vip_grants')} (steam_id, group_id, expires_at, active)
           VALUES (?, ?, DATE_ADD(UTC_TIMESTAMP(), INTERVAL ? DAY), 1)
           ON DUPLICATE KEY UPDATE
             expires_at = DATE_ADD(GREATEST(UTC_TIMESTAMP(),
               CASE WHEN active = 1 THEN expires_at ELSE UTC_TIMESTAMP() END), INTERVAL ? DAY),
             active = 1`,
          [steam, pkg.group_id, days, days],
        );
        return null;
      }
      default:
        throw new BadRequestException('invalid_type');
    }
  }

  private prizeLabel(p: GachaPrize): string {
    if (p.label) return p.label;
    if (p.type === 'coins') return `${p.amount} Coins`;
    if (p.type === 'meowcoins') return `${p.amount} Meowcoins`;
    if (p.type === 'vip') return 'VIP';
    return `#${p.ref_id} x${p.amount}`;
  }

  private async recordDraw(steam: string, prize: GachaPrize, code: string | null, day: string) {
    await this.db.query(
      `INSERT INTO ${this.drawsTbl()}
        (steam_id, prize_id, prize_type, prize_label, prize_amount, prize_image_url, rarity, code, gacha_day)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        steam, prize.id, prize.type, this.prizeLabel(prize), prize.amount,
        prize.image_url, prize.rarity, code, day,
      ],
    );
  }

  async spinBatch(user: GachaUser, count: number): Promise<{ results: GachaSpinResult[]; remaining: number }> {
    const n = clampInt(count, 1, 50);
    const results: GachaSpinResult[] = [];
    for (let i = 0; i < n; i++) {
      try {
        const r = await this.spin(user);
        results.push(r);
        if (r.remaining === 0) break;
      } catch (e: any) {
        if (results.length === 0) throw e;
        break; // ran out mid-batch — return what we have
      }
    }
    if (results.length === 0) throw new ConflictException('no_spins');
    return { results, remaining: results[results.length - 1].remaining };
  }

  // ---- Top Today feed ----
  async today(limit = 20): Promise<GachaTodayEntry[]> {
    const n = clampInt(limit, 1, 50);
    const day = this.gachaDay();
    const rows = await this.db.query<any>(
      // Return created_at as a literal UTC ISO string straight from MySQL. The draws.created_at
      // DATETIME is stored UTC (the app's convention; see UTC_TIMESTAMP usage elsewhere), so we
      // format it with a trailing 'Z' rather than letting mysql2 re-interpret it under its default
      // timezone:'local' — which would shift `at` by the host's UTC offset and mislabel the feed.
      `SELECT d.prize_type, d.prize_label, d.prize_amount, d.prize_image_url, d.rarity,
              DATE_FORMAT(d.created_at, '%Y-%m-%dT%H:%i:%sZ') AS created_at,
              COALESCE(l.discord_username, l.discord_global_name, p.Name, 'Player') AS name
       FROM ${this.drawsTbl()} d
       LEFT JOIN ${this.db.table('sv', 'links')} l ON l.steam_id = d.steam_id
       LEFT JOIN \`PlayerStats\` p ON p.SteamId = d.steam_id
       WHERE d.gacha_day = ?
       ORDER BY d.created_at DESC
       LIMIT ?`,
      [day, n],
    );
    return rows.map((r) => ({
      name: r.name ?? 'Player',
      prizeType: r.prize_type,
      prizeLabel: r.prize_label,
      prizeAmount: Number(r.prize_amount),
      imageUrl: r.prize_image_url ?? null,
      rarity: r.rarity ?? null,
      at: r.created_at ?? '',
    }));
  }
}

function clampInt(v: any, min: number, max: number): number {
  const n = Math.floor(Number(v));
  if (!Number.isFinite(n)) return min;
  return Math.min(max, Math.max(min, n));
}

/** Normalize a price input: undefined keeps current; null/<=0 disables; else the positive int. */
function normPrice(input: number | null | undefined, current: number | null): number | null {
  if (input === undefined) return current;
  if (input === null) return null;
  const n = Math.floor(Number(input));
  return Number.isFinite(n) && n > 0 ? n : null;
}
