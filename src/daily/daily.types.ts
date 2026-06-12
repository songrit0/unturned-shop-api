/** The two flat daily-reward tiers. VIP is resolved from an active sv_vip_grants row. */
export type DailyTier = 'normal' | 'vip';

/** Kind discriminator on a reward good — mirrors rc_code_items.kind (0=item, 1=vehicle). */
export type DailyKind = 0 | 1;

/** One configured physical good in a tier's bundle (sv_daily_reward_items row). */
export interface DailyRewardItem {
  id: number;
  tier: DailyTier;
  itemId: number;
  amount: number;
  quality: number;
  kind: DailyKind;
  label: string | null;
  imageUrl: string | null;
  sort: number;
  enabled: boolean;
}

/** A tier's scalar config (sv_daily_reward_config row), without its item list. */
export interface DailyTierConfig {
  tier: DailyTier;
  enabled: boolean;
  coins: number;
  codeTtlDays: number;
}

/** A tier's full admin view: scalar config + its items split by kind. */
export interface DailyTierAdminView extends Omit<DailyTierConfig, 'tier'> {
  items: DailyRewardItem[];     // kind === 0
  vehicles: DailyRewardItem[];  // kind === 1
}

/** GET /admin/daily/config response. */
export interface DailyAdminConfig {
  tiers: { normal: DailyTierAdminView; vip: DailyTierAdminView };
}

/** A reward good as surfaced to the player (preview + granted summary). */
export interface DailyRewardGood {
  itemId: number;
  amount: number;
  quality: number;
  label: string | null;
  imageUrl?: string | null;
  kind: DailyKind;
}

/** The bundle a tier grants, split into items (kind 0) and vehicles (kind 1). */
export interface DailyRewardBundle {
  coins: number;
  items: DailyRewardGood[];
  vehicles: DailyRewardGood[];
}

/** GET /daily/status response. */
export interface DailyStatus {
  enabled: boolean;
  tier: DailyTier;
  canClaim: boolean;
  alreadyClaimedToday: boolean;
  nextResetAt: string;     // ISO-8601 UTC
  reward: DailyRewardBundle;
}

/** POST /daily/claim success response. */
export interface DailyClaimResult {
  ok: true;
  tier: DailyTier;
  granted: DailyRewardBundle;
  redeemCode: string | null;  // 1-use rc_code for items+vehicles; null when the bundle had no goods
  nextResetAt: string;
}
