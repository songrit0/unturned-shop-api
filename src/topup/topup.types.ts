export type TopupStatus =
  | 'pending'
  | 'confirmed'
  | 'credited'
  | 'expired'
  | 'cancelled'
  | 'failed';

export type TopupProvider = 'plernpay' | 'thunder';

/** Row shape in the Pi5-local `topups` table. */
export interface TopupRow {
  id: number;
  ref: string;
  steam_id: string;
  discord_id: string | null;
  baht: string;
  unique_amount: string;
  vcoins: string;
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
  vcoins: number;
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
  vcoins: number;
  expires_at: string | null;
  status: TopupStatus;
}

/** Response of POST /topup/thunder/verify on success. */
export interface ThunderVerifyView {
  ref: string;
  status: 'credited';
  vcoins: number;
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
  vcoins: number;
  expires_at: string | null;
  credited_at: string | null;
}

/** Response of GET /vcoins/me. */
export interface VcoinBalanceView {
  steam_id: string;
  balance: number;
}
