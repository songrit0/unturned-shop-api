export type TopupStatus =
  | 'pending'
  | 'confirmed'
  | 'credited'
  | 'expired'
  | 'cancelled'
  | 'failed';

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
  created_at: string;
  expires_at: string | null;
  confirmed_at: string | null;
  credited_at: string | null;
}

/** Response of POST /topup/create. */
export interface TopupCreateView {
  ref: string;
  unique_amount: number;
  qr_code: string;
  promptpay_id: string;
  expires_at: string | null;
  vcoins: number;
  status: TopupStatus;
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
