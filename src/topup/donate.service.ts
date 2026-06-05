import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  Logger,
} from '@nestjs/common';
import * as mysql from 'mysql2/promise';
import { DbService } from '../database/db.service';
import { JwtPayload } from '../auth/strategies/jwt.strategy';
import { PurchasesService } from '../purchases/purchases.service';
import { TopupDbService } from './topup-db.service';
import { TopupService } from './topup.service';
import {
  AdminDonationTierView,
  DonateClaimView,
  DonateProgressView,
  DonateRewardKind,
  DonateRewardView,
  DonateTierProgressView,
  DonationTierRewardRow,
  DonationTierRow,
} from './topup.types';

/** Lifetime (days) of the redeem code minted on a tier claim. */
const CLAIM_CODE_TTL_DAYS = 30;

/**
 * Donate / Battlepass service. Spans BOTH databases:
 *  - TopupDbService (Pi5-local): topups aggregates + donation_tiers / donation_tier_rewards / donation_claims.
 *  - DbService (external shop DB): redeem-code mint (rc_codes / rc_code_items / sv_code_owners),
 *    reward name/image resolution (sv_items / sv_vehicles), and best-effort notifications.
 * Reuses TopupService for identity resolution + monthly aggregates + cap/goal config.
 */
@Injectable()
export class DonateService {
  private readonly log = new Logger(DonateService.name);

  constructor(
    private readonly topupDb: TopupDbService,
    private readonly shopDb: DbService,
    private readonly topup: TopupService,
    private readonly purchases: PurchasesService,
  ) {}

  private codeItemsTbl() { return this.shopDb.table('rc', 'code_items'); }
  private codeOwnersTbl() { return this.shopDb.table('sv', 'code_owners'); }
  private itemsTbl() { return this.shopDb.table('sv', 'items'); }
  private vehiclesTbl() { return this.shopDb.table('sv', 'vehicles'); }
  private linksTbl() { return this.shopDb.table('sv', 'links'); }
  private notificationsTbl() { return this.shopDb.table('sv', 'notifications'); }

  // ---- reward name/image resolution (shop DB) -------------------------------

  /**
   * Resolve reward names/images for a set of tier reward rows, keyed by tier_id.
   * kind 0 = item (sv_items), kind 1 = vehicle (sv_vehicles) — separate id spaces, so we look up
   * each set against its own catalog (mirrors admin-codes.service.itemsForCodes).
   */
  private async resolveRewards(rows: DonationTierRewardRow[]): Promise<Map<number, DonateRewardView[]>> {
    const byTier = new Map<number, DonateRewardView[]>();
    if (rows.length === 0) return byTier;

    const itemIds = [...new Set(rows.filter(r => Number(r.kind) === 0).map(r => Number(r.item_id)))];
    const vehicleIds = [...new Set(rows.filter(r => Number(r.kind) === 1).map(r => Number(r.item_id)))];

    const itemNames = new Map<number, { name: string | null; image_url: string | null }>();
    const vehicleNames = new Map<number, { name: string | null; image_url: string | null }>();

    if (itemIds.length > 0) {
      const found = await this.shopDb.query<{ id: number; name: string | null; image_url: string | null }>(
        `SELECT id, name, image_url FROM ${this.itemsTbl()} WHERE id IN (${itemIds.map(() => '?').join(',')})`,
        itemIds,
      );
      for (const f of found) itemNames.set(Number(f.id), { name: f.name, image_url: f.image_url });
    }
    if (vehicleIds.length > 0) {
      const found = await this.shopDb.query<{ id: number; name: string | null; image_url: string | null }>(
        `SELECT id, name, image_url FROM ${this.vehiclesTbl()} WHERE id IN (${vehicleIds.map(() => '?').join(',')})`,
        vehicleIds,
      );
      for (const f of found) vehicleNames.set(Number(f.id), { name: f.name, image_url: f.image_url });
    }

    for (const r of rows) {
      const kindNum = Number(r.kind);
      const kind: DonateRewardKind = kindNum === 1 ? 'vehicle' : 'item';
      const meta = (kindNum === 1 ? vehicleNames : itemNames).get(Number(r.item_id));
      const view: DonateRewardView = {
        kind,
        item_id: Number(r.item_id),
        amount: Number(r.amount),
        quality: Number(r.quality),
        name: meta?.name ?? null,
        image_url: meta?.image_url ?? null,
      };
      const arr = byTier.get(Number(r.tier_id)) || [];
      arr.push(view);
      byTier.set(Number(r.tier_id), arr);
    }
    return byTier;
  }

  /** All reward rows for the given tier ids (Pi5). */
  private async rewardsForTiers(tierIds: number[]): Promise<DonationTierRewardRow[]> {
    if (tierIds.length === 0) return [];
    return this.topupDb.query<DonationTierRewardRow>(
      `SELECT id, tier_id, kind, item_id, amount, quality FROM donation_tier_rewards
        WHERE tier_id IN (${tierIds.map(() => '?').join(',')})
        ORDER BY id ASC`,
      tierIds,
    );
  }

  // ---- GET /donate/progress -------------------------------------------------

  async progress(user: JwtPayload): Promise<DonateProgressView> {
    const { steamId } = await this.topup.resolveIdentity(user);
    const { period } = this.topup.monthBounds();

    const cap = this.topup.monthlyCapBaht();
    const goal = this.topup.monthlyGoalBaht();
    const userDonated = await this.topup.userDonatedThisMonth(steamId);
    const communityTotal = await this.topup.communityTotalThisMonth();

    const tiers = await this.topupDb.query<DonationTierRow>(
      `SELECT id, threshold_baht, name, enabled, sort, created_at FROM donation_tiers
        WHERE enabled = 1 ORDER BY sort ASC, threshold_baht ASC`,
    );
    const tierIds = tiers.map(t => Number(t.id));
    const rewardsByTier = await this.resolveRewards(await this.rewardsForTiers(tierIds));

    // Claims for this user this period, keyed by tier_id.
    const claimsByTier = new Map<number, { code: string | null }>();
    if (tierIds.length > 0) {
      const claims = await this.topupDb.query<{ tier_id: number; code: string | null }>(
        `SELECT tier_id, code FROM donation_claims
          WHERE steam_id = ? AND period = ? AND tier_id IN (${tierIds.map(() => '?').join(',')})`,
        [steamId, period, ...tierIds],
      );
      for (const c of claims) claimsByTier.set(Number(c.tier_id), { code: c.code });
    }

    const tierViews: DonateTierProgressView[] = tiers.map(t => {
      const id = Number(t.id);
      const claim = claimsByTier.get(id);
      return {
        id,
        threshold_baht: Number(t.threshold_baht),
        name: t.name,
        sort: Number(t.sort),
        rewards: rewardsByTier.get(id) || [],
        unlocked: userDonated >= Number(t.threshold_baht),
        claimed: !!claim,
        code: claim?.code ?? null,
      };
    });

    return {
      period,
      user_donated: userDonated,
      user_cap: cap,
      user_remaining: Math.max(0, cap - userDonated),
      community_total: communityTotal,
      community_goal: goal,
      tiers: tierViews,
    };
  }

  // ---- POST /donate/claim ---------------------------------------------------

  async claim(user: JwtPayload, tierId: number): Promise<DonateClaimView> {
    if (!Number.isInteger(tierId) || tierId < 1) {
      throw new BadRequestException('tier_not_found');
    }
    const { steamId, discordId } = await this.topup.resolveIdentity(user);
    const { period } = this.topup.monthBounds();

    // Load the tier (must be enabled).
    const tier = await this.topupDb.first<DonationTierRow>(
      `SELECT id, threshold_baht, name, enabled, sort, created_at FROM donation_tiers
        WHERE id = ? AND enabled = 1`,
      [tierId],
    );
    if (!tier) throw new BadRequestException('tier_not_found');

    const rewardRows = await this.rewardsForTiers([tierId]);
    const rewardsByTier = await this.resolveRewards(rewardRows);
    const rewards = rewardsByTier.get(tierId) || [];

    // Idempotent: an existing claim WITH a code → return it.
    const existing = await this.topupDb.first<{ id: number; code: string | null }>(
      `SELECT id, code FROM donation_claims WHERE steam_id = ? AND tier_id = ? AND period = ?`,
      [steamId, tierId, period],
    );
    if (existing && existing.code) {
      return { code: existing.code, already: true, code_expires_at: null, rewards };
    }

    // Gate: cumulative CREDITED donations this month must reach the threshold.
    const donated = await this.topup.userDonatedThisMonth(steamId);
    if (donated < Number(tier.threshold_baht)) {
      throw new ForbiddenException('tier_locked');
    }

    // (a) Reserve the claim row on the Pi5 DB. The UNIQUE(steam_id,tier_id,period) guards races.
    let claimId: number;
    if (existing) {
      // A reservation exists but has no code yet (a prior attempt crashed before stamping the code).
      // Reuse it; the saga below will mint a fresh code and stamp it.
      claimId = Number(existing.id);
    } else {
      try {
        const res = await this.topupDb.query<mysql.ResultSetHeader>(
          `INSERT INTO donation_claims (steam_id, tier_id, period, code) VALUES (?, ?, ?, NULL)`,
          [steamId, tierId, period],
        );
        claimId = Number((res as unknown as mysql.ResultSetHeader).insertId);
      } catch (e: any) {
        if (e?.code === 'ER_DUP_ENTRY') {
          // Lost the race: re-read and return the winner's code if it has one.
          const winner = await this.topupDb.first<{ id: number; code: string | null }>(
            `SELECT id, code FROM donation_claims WHERE steam_id = ? AND tier_id = ? AND period = ?`,
            [steamId, tierId, period],
          );
          if (winner && winner.code) {
            return { code: winner.code, already: true, code_expires_at: null, rewards };
          }
          // Winner reserved but hasn't stamped a code yet — tell the client to retry shortly.
          throw new ForbiddenException('already_claimed');
        }
        throw e;
      }
    }

    // (b) Mint the redeem code + reward items + ownership in ONE shop-DB transaction.
    let code: string;
    let codeExpiresAt: string | null = null;
    const conn = await this.shopDb.getConnection();
    try {
      await conn.beginTransaction();
      const minted = await this.purchases.insertNewCode(conn, CLAIM_CODE_TTL_DAYS);
      code = minted.code;
      for (const rw of rewards) {
        await conn.query(
          `INSERT INTO ${this.codeItemsTbl()} (code_id, item_id, amount, quality, state, rot, kind)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
          [minted.codeId, rw.item_id, rw.amount, rw.quality, '', 0, rw.kind === 'vehicle' ? 1 : 0],
        );
      }
      await conn.query(
        `INSERT INTO ${this.codeOwnersTbl()} (code_id, steam_id) VALUES (?, ?)`,
        [minted.codeId, steamId],
      );
      // Read back the expiry MySQL computed (NOW() + N days) for the response/notification.
      const [expRows] = await conn.query<mysql.RowDataPacket[]>(
        `SELECT expires_at FROM ${this.shopDb.table('rc', 'codes')} WHERE id = ?`,
        [minted.codeId],
      );
      codeExpiresAt = expRows[0]?.expires_at ?? null;
      await conn.commit();
    } catch (e) {
      try { await conn.rollback(); } catch { /* ignore */ }
      // (d) Saga failed AFTER reserving the claim row — release it so the user can retry.
      try {
        await this.topupDb.query(`DELETE FROM donation_claims WHERE id = ? AND code IS NULL`, [claimId]);
      } catch (delErr: any) {
        this.log.error(`claim(${tierId}) steam=${steamId}: failed to release reservation ${claimId}: ${delErr.message}`);
      }
      throw e;
    } finally {
      conn.release();
    }

    // (c) Stamp the code onto the reserved claim row (Pi5).
    await this.topupDb.query(
      `UPDATE donation_claims SET code = ? WHERE id = ?`,
      [code, claimId],
    );

    // (e) Best-effort notification (web inbox + bot DM source). Never fails the claim.
    if (discordId) {
      try {
        const payload = {
          tier_id: tierId,
          name: tier.name,
          code,
          code_expires_at: codeExpiresAt,
        };
        await this.shopDb.query(
          `INSERT INTO ${this.notificationsTbl()} (discord_id, steam_id, kind, payload) VALUES (?, ?, ?, ?)`,
          [discordId, steamId, 'donate_tier_unlocked', JSON.stringify(payload)],
        );
      } catch (e: any) {
        this.log.warn(`claim(${tierId}) steam=${steamId}: notification insert failed (code ${code} minted): ${e.message}`);
      }
    }

    return { code, code_expires_at: codeExpiresAt, rewards };
  }

  // ---- Admin tier CRUD ------------------------------------------------------

  /** GET /admin/donate/tiers — all tiers (incl. disabled) with rewards resolved. */
  async adminListTiers(): Promise<AdminDonationTierView[]> {
    const tiers = await this.topupDb.query<DonationTierRow>(
      `SELECT id, threshold_baht, name, enabled, sort, created_at FROM donation_tiers
        ORDER BY sort ASC, threshold_baht ASC`,
    );
    const tierIds = tiers.map(t => Number(t.id));
    const rewardsByTier = await this.resolveRewards(await this.rewardsForTiers(tierIds));
    return tiers.map(t => ({
      id: Number(t.id),
      threshold_baht: Number(t.threshold_baht),
      name: t.name,
      enabled: Number(t.enabled),
      sort: Number(t.sort),
      created_at: t.created_at,
      rewards: rewardsByTier.get(Number(t.id)) || [],
    }));
  }

  /** Validate + normalize an incoming rewards array (>=1 reward). */
  private normalizeRewards(rewards: unknown): { kind: number; item_id: number; amount: number; quality: number }[] {
    if (!Array.isArray(rewards) || rewards.length === 0) {
      throw new BadRequestException('rewards must be a non-empty array');
    }
    return rewards.map((rw: any, idx: number) => {
      const kindRaw = rw?.kind;
      const kind = kindRaw === 'vehicle' || Number(kindRaw) === 1 ? 1 : 0;
      const itemId = Number(rw?.item_id);
      if (!Number.isInteger(itemId) || itemId < 1) {
        throw new BadRequestException(`rewards[${idx}].item_id must be a positive integer`);
      }
      const amount = rw?.amount === undefined || rw?.amount === null ? 1 : Number(rw.amount);
      if (!Number.isInteger(amount) || amount < 1) {
        throw new BadRequestException(`rewards[${idx}].amount must be an integer >= 1`);
      }
      let quality = rw?.quality === undefined || rw?.quality === null ? 100 : Number(rw.quality);
      if (!Number.isFinite(quality)) quality = 100;
      quality = Math.max(0, Math.min(100, Math.round(quality)));
      return { kind, item_id: itemId, amount, quality };
    });
  }

  /** POST /admin/donate/tiers — create a tier + its rewards. */
  async adminCreateTier(input: {
    threshold_baht: number; name: string; enabled?: boolean; sort?: number; rewards: unknown;
  }): Promise<AdminDonationTierView> {
    const threshold = Number(input.threshold_baht);
    if (!Number.isInteger(threshold) || threshold <= 0) {
      throw new BadRequestException('threshold_baht must be a positive integer');
    }
    const name = typeof input.name === 'string' ? input.name.trim() : '';
    if (!name) throw new BadRequestException('name is required');
    const enabled = input.enabled === false ? 0 : 1;
    const sort = Number.isFinite(Number(input.sort)) ? Math.floor(Number(input.sort)) : 0;
    const rewards = this.normalizeRewards(input.rewards);

    const conn = await this.topupDb.getConnection();
    let tierId: number;
    try {
      await conn.beginTransaction();
      const [res] = await conn.query<mysql.ResultSetHeader>(
        `INSERT INTO donation_tiers (threshold_baht, name, enabled, sort) VALUES (?, ?, ?, ?)`,
        [threshold, name, enabled, sort],
      );
      tierId = Number(res.insertId);
      for (const rw of rewards) {
        await conn.query(
          `INSERT INTO donation_tier_rewards (tier_id, kind, item_id, amount, quality) VALUES (?, ?, ?, ?, ?)`,
          [tierId, rw.kind, rw.item_id, rw.amount, rw.quality],
        );
      }
      await conn.commit();
    } catch (e) {
      try { await conn.rollback(); } catch { /* ignore */ }
      throw e;
    } finally {
      conn.release();
    }
    const [view] = (await this.adminListTiers()).filter(t => t.id === tierId);
    return view;
  }

  /** PUT /admin/donate/tiers/:id — update fields + REPLACE rewards. */
  async adminUpdateTier(id: number, input: {
    threshold_baht: number; name: string; enabled?: boolean; sort?: number; rewards: unknown;
  }): Promise<AdminDonationTierView> {
    const existing = await this.topupDb.first<DonationTierRow>(
      `SELECT id FROM donation_tiers WHERE id = ?`, [id],
    );
    if (!existing) throw new BadRequestException('tier_not_found');

    const threshold = Number(input.threshold_baht);
    if (!Number.isInteger(threshold) || threshold <= 0) {
      throw new BadRequestException('threshold_baht must be a positive integer');
    }
    const name = typeof input.name === 'string' ? input.name.trim() : '';
    if (!name) throw new BadRequestException('name is required');
    const enabled = input.enabled === false ? 0 : 1;
    const sort = Number.isFinite(Number(input.sort)) ? Math.floor(Number(input.sort)) : 0;
    const rewards = this.normalizeRewards(input.rewards);

    const conn = await this.topupDb.getConnection();
    try {
      await conn.beginTransaction();
      await conn.query(
        `UPDATE donation_tiers SET threshold_baht = ?, name = ?, enabled = ?, sort = ? WHERE id = ?`,
        [threshold, name, enabled, sort, id],
      );
      await conn.query(`DELETE FROM donation_tier_rewards WHERE tier_id = ?`, [id]);
      for (const rw of rewards) {
        await conn.query(
          `INSERT INTO donation_tier_rewards (tier_id, kind, item_id, amount, quality) VALUES (?, ?, ?, ?, ?)`,
          [id, rw.kind, rw.item_id, rw.amount, rw.quality],
        );
      }
      await conn.commit();
    } catch (e) {
      try { await conn.rollback(); } catch { /* ignore */ }
      throw e;
    } finally {
      conn.release();
    }
    const [view] = (await this.adminListTiers()).filter(t => t.id === id);
    return view;
  }

  /** DELETE /admin/donate/tiers/:id — delete the tier + its rewards. Claims are kept as history. */
  async adminDeleteTier(id: number): Promise<{ ok: true }> {
    const conn = await this.topupDb.getConnection();
    try {
      await conn.beginTransaction();
      await conn.query(`DELETE FROM donation_tier_rewards WHERE tier_id = ?`, [id]);
      await conn.query(`DELETE FROM donation_tiers WHERE id = ?`, [id]);
      await conn.commit();
    } catch (e) {
      try { await conn.rollback(); } catch { /* ignore */ }
      throw e;
    } finally {
      conn.release();
    }
    return { ok: true };
  }
}
