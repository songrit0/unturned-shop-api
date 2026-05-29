/** Stored notification row (sv_notifications). `payload` shape depends on `kind`. */
export interface NotificationRow {
  id: number;
  discord_id: string;
  steam_id: string | null;
  kind: string;
  payload: unknown;
  dm_status: string;
  dm_attempts: number;
  dm_sent_at: Date | null;
  read_at: Date | null;
  created_at: Date;
}

/** Payload for the P2P refund kinds (`p2p_expired`, `p2p_cancelled`). */
export interface P2pRefundPayload {
  listing_id: number;
  item_id: number;
  item_name: string | null;
  image_url: string | null;
  amount: number;
  quality: number;
  code: string;
  code_expires_at: string | null;
}

/** Shape returned to the web client (mirrors the contract shared with the web agent). */
export interface NotificationView {
  id: number;
  kind: string;
  payload: unknown;
  read_at: Date | null;
  created_at: Date;
}
