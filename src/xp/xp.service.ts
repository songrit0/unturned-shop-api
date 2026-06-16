import { BadRequestException, ConflictException, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { DbService } from '../database/db.service';

export interface XpMe {
  steam_id: string | null;
  linked: boolean;
  online: boolean;
  xp: number;
  rate: number;
  fee_percent: number;
  min: number;
  preview_coins: number;   // coins for converting ALL current XP (after fee)
  updated_at: string | null;
}

export interface XpConfig {
  rate: number;
  fee_percent: number;
  min: number;
}

export interface XpRequestStatus {
  id: number;
  status: 'pending' | 'processing' | 'done' | 'insufficient' | 'offline' | 'error';
  requested_xp: number;
  coins_granted: number | null;
  xp_spent: number | null;
  created_at: string;
  processed_at: string | null;
}

/**
 * XP -> Coins (web side). The web NEVER touches XP — that is server-only state. It reads the live
 * mirror the GameMenu plugin writes (sv_player_xp) and queues conversion requests (sv_xp_requests)
 * that the plugin processes in-game. Conversion is ONLINE-ONLY: the request is rejected unless the
 * mirror shows the player online with enough XP (the plugin re-validates authoritatively).
 */
@Injectable()
export class XpService {
  private readonly log = new Logger(XpService.name);

  constructor(private readonly db: DbService, private readonly cfg: ConfigService) {}

  // ---- config (mirror the plugin) -------------------------------------------
  rate(): number { const v = Number(this.cfg.get('xp.rate')); return Number.isFinite(v) && v > 0 ? v : 1; }
  feePercent(): number { const v = Number(this.cfg.get('xp.feePercent')); return Number.isFinite(v) && v >= 0 ? Math.min(100, v) : 10; }
  min(): number { const v = Number(this.cfg.get('xp.min')); return Number.isFinite(v) && v >= 1 ? Math.floor(v) : 100; }

  config(): XpConfig { return { rate: this.rate(), fee_percent: this.feePercent(), min: this.min() }; }

  /** Net coins for converting `xp` XP: floor(xp * rate * (1 - fee%)). Mirrors XpConverter.CoinsFor. */
  coinsFor(xp: number): number {
    const net = xp * this.rate() * (1 - this.feePercent() / 100);
    return net <= 0 ? 0 : Math.floor(net);
  }

  /** XP needed to RECEIVE `coins`: ceil(coins / (rate * (1 - fee%))). Inverse of coinsFor. */
  xpFor(coins: number): number {
    const per = this.rate() * (1 - this.feePercent() / 100);
    if (per <= 0 || coins <= 0) return 0;
    return Math.ceil(coins / per);
  }

  /** Fewest coins a conversion can yield (payout at the XP minimum) — for the web's min hint. */
  minCoins(): number { return this.coinsFor(this.min()); }

  async me(steamId: string | null): Promise<XpMe> {
    const base: XpMe = {
      steam_id: steamId, linked: !!steamId, online: false, xp: 0,
      rate: this.rate(), fee_percent: this.feePercent(), min: this.min(),
      preview_coins: 0, updated_at: null,
    };
    if (!steamId) return base;
    const t = this.db.table('sv', 'player_xp');
    const row = await this.db.first<{ xp: string | number; online: number; updated_at: string }>(
      `SELECT xp, online, updated_at FROM ${t} WHERE steam_id = ? LIMIT 1`, [steamId],
    );
    if (!row) return base;
    const xp = Number(row.xp) || 0;
    return { ...base, xp, online: Number(row.online) === 1, preview_coins: this.coinsFor(xp), updated_at: row.updated_at ?? null };
  }

  /** Queue an online-only conversion for a TARGET coin amount. We store the XP it costs
   * (requested_xp = ceil(coins / payoutPerXp)); the plugin deducts that XP and credits back the
   * coins (floor(requested_xp * payoutPerXp) == coins when rate <= 1). The plugin re-validates. */
  async convert(steamId: string | null, coins: number): Promise<{ request_id: number; status: 'pending'; requested_xp: number }> {
    if (!steamId) throw new BadRequestException('not_linked');
    const want = Math.floor(Number(coins));
    if (!Number.isFinite(want) || want <= 0) throw new BadRequestException('bad_amount');

    const xpNeeded = this.xpFor(want);
    if (xpNeeded < this.min()) throw new BadRequestException('below_min');   // coins too small (below the XP floor)

    const xpT = this.db.table('sv', 'player_xp');
    const mirror = await this.db.first<{ xp: string | number; online: number }>(
      `SELECT xp, online FROM ${xpT} WHERE steam_id = ? LIMIT 1`, [steamId],
    );
    if (!mirror || Number(mirror.online) !== 1) throw new BadRequestException('not_online');
    if ((Number(mirror.xp) || 0) < xpNeeded) throw new BadRequestException('insufficient_xp');

    const reqT = this.db.table('sv', 'xp_requests');
    // one in-flight request per player (avoids double-spend windows + UI confusion)
    const open = await this.db.first<{ id: number }>(
      `SELECT id FROM ${reqT} WHERE steam_id = ? AND status IN ('pending','processing') ORDER BY id DESC LIMIT 1`, [steamId],
    );
    if (open) throw new ConflictException('request_pending');

    const res: any = await this.db.query(
      `INSERT INTO ${reqT} (steam_id, requested_xp, status, source) VALUES (?, ?, 'pending', 'web')`,
      [steamId, xpNeeded],
    );
    return { request_id: Number(res?.insertId || 0), status: 'pending', requested_xp: xpNeeded };
  }

  async requestStatus(steamId: string | null, id: number): Promise<XpRequestStatus> {
    if (!steamId) throw new BadRequestException('not_linked');
    if (!Number.isFinite(id) || id <= 0) throw new BadRequestException('bad_request_id');
    const reqT = this.db.table('sv', 'xp_requests');
    const row = await this.db.first<any>(
      `SELECT id, requested_xp, status, coins_granted, xp_spent, created_at, processed_at
       FROM ${reqT} WHERE id = ? AND steam_id = ? LIMIT 1`, [id, steamId],
    );
    if (!row) throw new BadRequestException('request_not_found');
    return {
      id: Number(row.id),
      status: row.status,
      requested_xp: Number(row.requested_xp),
      coins_granted: row.coins_granted == null ? null : Number(row.coins_granted),
      xp_spent: row.xp_spent == null ? null : Number(row.xp_spent),
      created_at: row.created_at,
      processed_at: row.processed_at ?? null,
    };
  }
}
