import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { DbService } from '../database/db.service';
import { Paginated, normalizePage } from '../common/pagination';

export interface VipPackageRow {
  id: number;
  tier: string;
  group_id: string;
  days: number;
  price_coins: number;
  /** Meowcoin price, or null when this package is not buyable with Meowcoin. */
  price_meowcoins: number | null;
  label: string | null;
  sort: number;
  enabled: number;
}

export interface VipGrantRow {
  id: number;
  steam_id: string;
  group_id: string;
  expires_at: Date;
  active: number;
  updated_at: Date;
  discord_id?: string | null;
  discord_username?: string | null;
}

export interface VipPackageInput {
  tier: string;
  group_id: string;
  days: number;
  price_coins: number;
  /** Meowcoin price; null/0/omitted = not sold with Meowcoin. */
  price_meowcoins?: number | null;
  label?: string;
  sort?: number;
  enabled?: boolean;
}

/** Normalize a Meowcoin price input to a positive int, or null when not sold with Meowcoin. */
function meowPrice(v: number | null | undefined): number | null {
  return v != null && Number(v) > 0 ? Math.trunc(Number(v)) : null;
}

/**
 * Admin management for the VIP system. Writes the sv_vip_* tables that the VIP Unturned plugin
 * reconciles against (it adds/removes the RocketMod group within ~1 min of a change). All expiry
 * times are UTC, matching the plugin's UTC_TIMESTAMP() usage.
 */
@Injectable()
export class AdminVipService {
  constructor(private readonly db: DbService) {}

  private pkgTable() { return this.db.table('sv', 'vip_packages'); }
  private grantTable() { return this.db.table('sv', 'vip_grants'); }
  private logTable() { return this.db.table('sv', 'vip_log'); }

  // ---- packages ----

  async listPackages(): Promise<VipPackageRow[]> {
    return this.db.query<VipPackageRow>(
      `SELECT id, tier, group_id, days, price_coins, price_meowcoins, label, sort, enabled
       FROM ${this.pkgTable()} ORDER BY sort ASC, price_coins ASC`,
    );
  }

  async createPackage(input: VipPackageInput): Promise<VipPackageRow> {
    this.validatePackage(input);
    const res: any = await this.db.query(
      `INSERT INTO ${this.pkgTable()} (tier, group_id, days, price_coins, price_meowcoins, label, sort, enabled)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        input.tier, input.group_id, input.days, input.price_coins, meowPrice(input.price_meowcoins),
        input.label ?? null, input.sort ?? 0, input.enabled === false ? 0 : 1,
      ],
    );
    const id = (res as any)?.insertId ?? (Array.isArray(res) ? (res[0] as any)?.insertId : undefined);
    return this.getPackage(Number(id));
  }

  async getPackage(id: number): Promise<VipPackageRow> {
    const row = await this.db.first<VipPackageRow>(
      `SELECT id, tier, group_id, days, price_coins, price_meowcoins, label, sort, enabled
       FROM ${this.pkgTable()} WHERE id = ? LIMIT 1`,
      [id],
    );
    if (!row) throw new NotFoundException('Package not found');
    return row;
  }

  async updatePackage(id: number, input: Partial<VipPackageInput>): Promise<VipPackageRow> {
    await this.getPackage(id); // 404 if missing
    const sets: string[] = [];
    const params: any[] = [];
    const map: Record<string, any> = {
      tier: input.tier, group_id: input.group_id, days: input.days,
      price_coins: input.price_coins,
      price_meowcoins: input.price_meowcoins === undefined ? undefined : meowPrice(input.price_meowcoins),
      label: input.label, sort: input.sort,
      enabled: input.enabled === undefined ? undefined : input.enabled ? 1 : 0,
    };
    for (const [col, val] of Object.entries(map)) {
      if (val !== undefined) { sets.push(`${col} = ?`); params.push(val); }
    }
    if (sets.length === 0) return this.getPackage(id);
    params.push(id);
    await this.db.query(`UPDATE ${this.pkgTable()} SET ${sets.join(', ')} WHERE id = ?`, params);
    return this.getPackage(id);
  }

  async deletePackage(id: number): Promise<{ deleted: boolean }> {
    await this.getPackage(id);
    await this.db.query(`DELETE FROM ${this.pkgTable()} WHERE id = ?`, [id]);
    return { deleted: true };
  }

  // ---- grants ----

  /** All grants (optionally filtered), active first then newest expiry, paginated. Joins the
   * Discord link so the admin sees who each steam id is. activeOnly hides expired/revoked rows. */
  async listGrants(page?: number, limit?: number, search = '', activeOnly = false): Promise<Paginated<VipGrantRow>> {
    const np = normalizePage(page, limit);
    const links = this.db.table('sv', 'links');
    const where: string[] = [];
    const params: any[] = [];
    if (activeOnly) where.push(`g.active = 1 AND g.expires_at > UTC_TIMESTAMP()`);
    if (search?.trim()) {
      where.push(`(g.steam_id LIKE ? OR g.group_id LIKE ? OR l.discord_id LIKE ? OR l.discord_username LIKE ?)`);
      const s = `%${search.trim()}%`;
      params.push(s, s, s, s);
    }
    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';

    const cnt = await this.db.first<{ c: number }>(
      `SELECT COUNT(*) AS c FROM ${this.grantTable()} g LEFT JOIN ${links} l ON l.steam_id = g.steam_id ${whereSql}`,
      params,
    );
    const total = cnt ? Number(cnt.c) : 0;
    const items = await this.db.query<VipGrantRow>(
      `SELECT g.id, g.steam_id, g.group_id, g.expires_at, g.active, g.updated_at,
              l.discord_id, l.discord_username
       FROM ${this.grantTable()} g
       LEFT JOIN ${links} l ON l.steam_id = g.steam_id
       ${whereSql}
       ORDER BY g.active DESC, g.expires_at DESC LIMIT ? OFFSET ?`,
      [...params, np.limit, np.offset],
    );
    return { items, total, page: np.page, limit: np.limit, pages: Math.ceil(total / np.limit) };
  }

  async grantsForUser(steamId: string): Promise<VipGrantRow[]> {
    return this.db.query<VipGrantRow>(
      `SELECT id, steam_id, group_id, expires_at, active, updated_at
       FROM ${this.grantTable()} WHERE steam_id = ? ORDER BY expires_at DESC`,
      [steamId],
    );
  }

  /** Extend (or create) a grant by N days. New expiry = later of (now / current expiry) + days. */
  async extend(steamId: string, groupId: string, days: number, actor: string): Promise<VipGrantRow> {
    if (!groupId?.trim()) throw new BadRequestException('group_id required');
    if (!Number.isInteger(days) || days <= 0) throw new BadRequestException('days must be a positive integer');
    await this.db.query(
      `INSERT INTO ${this.grantTable()} (steam_id, group_id, expires_at, active)
       VALUES (?, ?, DATE_ADD(UTC_TIMESTAMP(), INTERVAL ? DAY), 1)
       ON DUPLICATE KEY UPDATE
         expires_at = DATE_ADD(GREATEST(UTC_TIMESTAMP(),
           CASE WHEN active = 1 THEN expires_at ELSE UTC_TIMESTAMP() END), INTERVAL ? DAY),
         active = 1`,
      [steamId, groupId, days, days],
    );
    await this.log(steamId, groupId, 'grant', days, actor);
    return this.oneGrant(steamId, groupId);
  }

  /**
   * Set an absolute expiry (UTC). Always keeps active=1 — the VIP plugin is the single authority that
   * flips active=0, and it does so AFTER removing the player from the RocketMod group. So a past date
   * here = "let the plugin remove them"; a future date = "(re)grant". Setting active=0 directly here
   * would make the plugin skip the removal and leave them in the group in-game.
   */
  async setExpiry(steamId: string, groupId: string, expiresAtUtc: string, actor: string): Promise<VipGrantRow> {
    if (!groupId?.trim()) throw new BadRequestException('group_id required');
    const d = new Date(expiresAtUtc);
    if (isNaN(d.getTime())) throw new BadRequestException('expires_at must be a valid date');
    const mysqlDt = d.toISOString().slice(0, 19).replace('T', ' '); // UTC 'YYYY-MM-DD HH:MM:SS'
    await this.db.query(
      `INSERT INTO ${this.grantTable()} (steam_id, group_id, expires_at, active)
       VALUES (?, ?, ?, 1)
       ON DUPLICATE KEY UPDATE expires_at = VALUES(expires_at), active = 1`,
      [steamId, groupId, mysqlDt],
    );
    await this.log(steamId, groupId, 'set', 0, actor);
    return this.oneGrant(steamId, groupId);
  }

  /**
   * Revoke now: expires_at=now but KEEP active=1 so the plugin's expiry sweep picks it up
   * (active=1 AND expired), removes the player from the group, and only THEN sets active=0.
   * Setting active=0 here directly would leave them in the group in-game.
   */
  async revoke(steamId: string, groupId: string, actor: string): Promise<{ revoked: boolean }> {
    await this.db.query(
      `UPDATE ${this.grantTable()} SET active = 1, expires_at = UTC_TIMESTAMP()
       WHERE steam_id = ? AND group_id = ?`,
      [steamId, groupId],
    );
    await this.log(steamId, groupId, 'revoke', 0, actor);
    return { revoked: true };
  }

  private async oneGrant(steamId: string, groupId: string): Promise<VipGrantRow> {
    const row = await this.db.first<VipGrantRow>(
      `SELECT id, steam_id, group_id, expires_at, active, updated_at
       FROM ${this.grantTable()} WHERE steam_id = ? AND group_id = ? LIMIT 1`,
      [steamId, groupId],
    );
    if (!row) throw new NotFoundException('Grant not found');
    return row;
  }

  private async log(steamId: string, groupId: string, action: string, days: number, actor: string) {
    await this.db.query(
      `INSERT INTO ${this.logTable()} (steam_id, group_id, action, days, actor) VALUES (?, ?, ?, ?, ?)`,
      [steamId, groupId, action, days, (actor || 'admin').slice(0, 64)],
    );
  }

  private validatePackage(input: VipPackageInput) {
    if (!input.tier?.trim()) throw new BadRequestException('tier required');
    if (!input.group_id?.trim()) throw new BadRequestException('group_id required');
    if (!Number.isInteger(input.days) || input.days <= 0) throw new BadRequestException('days must be a positive integer');
    if (!Number.isFinite(input.price_coins) || input.price_coins < 0) throw new BadRequestException('price_coins must be >= 0');
    // A package must be sellable in at least one currency: Coin (price_coins>0) or Meowcoin (price_meowcoins>0).
    if (!(input.price_coins > 0) && meowPrice(input.price_meowcoins) == null) {
      throw new BadRequestException('price_required');
    }
  }
}
