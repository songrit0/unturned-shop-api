export type TopupStatus =
  | 'pending'
  | 'confirmed'
  | 'credited'
  | 'expired'
  | 'cancelled'
  | 'failed';

export type TopupProvider = 'plernpay' | 'thunder' | 'buymeacoffee';

/** Row shape in the Pi5-local `topups` table. */
export interface TopupRow {
  id: number;
  ref: string;
  steam_id: string;
  discord_id: string | null;
  baht: string;
  unique_amount: string;
  meowcoins: string;
  qr_code: string | null;
  promptpay_id: string | null;
  status: TopupStatus;
  provider: string;
  trans_ref: string | null;
  created_at: string;
  expires_at: string | null;
  confirmed_at: string | null;
  credited_at: string | null;
}

/** Response of POST /topup/create for the plernpay (auto PromptPay gateway) path. */
export interface TopupCreateView {
  ref: string;
  provider: 'plernpay';
  unique_amount: number;
  qr_code: string;
  promptpay_id: string;
  expires_at: string | null;
  meowcoins: number;
  status: TopupStatus;
}

/** Response of POST /topup/create for the thunder (manual PromptPay + slip upload) path. */
export interface ThunderCreateView {
  ref: string;
  provider: 'thunder';
  qr_code: string;
  promptpay_id: string;
  receiver_name: string | null;
  amount: number;
  meowcoins: number;
  expires_at: string | null;
  status: TopupStatus;
}

/** Response of POST /topup/thunder/verify on success. */
export interface ThunderVerifyView {
  ref: string;
  status: 'credited';
  meowcoins: number;
  balance: number;
}

/** A provider entry for the public config / admin registry. */
export interface ProviderRow {
  key: string;
  label: string | null;
  enabled: number;
  sort: number;
}

/** Response of GET /topup/:ref. */
export interface TopupStatusView {
  ref: string;
  status: TopupStatus;
  unique_amount: number;
  meowcoins: number;
  expires_at: string | null;
  credited_at: string | null;
}

/** Response of GET /meowcoins/me. */
export interface MeowcoinBalanceView {
  steam_id: string;
  balance: number;
}

/** Result of processing one BuyMeACoffee webhook event. */
export interface BmcWebhookResult {
  handled: boolean;
  reason?: string;
  steam_id?: string;
  baht?: number;
}

// ---- Donate / Battlepass ----

/** Reward kind discriminator on donation_tier_rewards.kind (0=item, 1=vehicle). */
export type DonateRewardKind = 'item' | 'vehicle';

/** Row shape in donation_tiers (Pi5). */
export interface DonationTierRow {
  id: number;
  threshold_baht: number;
  name: string;
  enabled: number;
  sort: number;
  created_at: string;
}

/** Row shape in donation_tier_rewards (Pi5). */
export interface DonationTierRewardRow {
  id: number;
  tier_id: number;
  kind: number;
  item_id: number;
  amount: number;
  quality: number;
}

/** A reward in API responses, with name/image resolved from the shop DB. */
export interface DonateRewardView {
  kind: DonateRewardKind;
  item_id: number;
  amount: number;
  quality: number;
  name: string | null;
  image_url: string | null;
}

/** A tier in GET /donate/progress. */
export interface DonateTierProgressView {
  id: number;
  threshold_baht: number;
  name: string;
  sort: number;
  rewards: DonateRewardView[];
  unlocked: boolean;
  claimed: boolean;
  code: string | null;
}

/** Response of GET /donate/progress. */
export interface DonateProgressView {
  period: string;
  user_donated: number;
  user_cap: number;
  user_remaining: number;
  community_total: number;
  community_goal: number;
  tiers: DonateTierProgressView[];
}

/** Response of POST /donate/claim. */
export interface DonateClaimView {
  code: string;
  code_expires_at: string | null;
  already?: boolean;
  rewards: DonateRewardView[];
}

/** A tier with its rewards (admin CRUD view). */
export interface AdminDonationTierView {
  id: number;
  threshold_baht: number;
  name: string;
  enabled: number;
  sort: number;
  created_at: string;
  rewards: DonateRewardView[];
}
