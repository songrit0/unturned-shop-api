export type P2PStatus = 'active' | 'sold' | 'cancelled' | 'expired';
export type P2PAction = 'list' | 'buy' | 'cancel' | 'expire' | 'admin_force_close';

export interface P2PListingRow {
  id: number;
  seller_steam: string;
  item_id: number;
  amount: number;
  quality: number;
  rot: number;
  state: string;
  price: number;
  status: P2PStatus;
  buyer_steam: string | null;
  created_at: Date;
  closed_at: Date | null;
  /**
   * Refund redeem code minted when the listing was cancelled/expired/force-closed.
   * Null for active/sold listings (and pre-rework closed listings). Single-use, expiring.
   */
  redeem_code: string | null;
  /** Expiry of `redeem_code` (MySQL DATETIME), or null. */
  code_expires_at: Date | null;
}

export interface P2PListingView extends P2PListingRow {
  item_name: string | null;
  image_url: string | null;
  type_id: number | null;
  type_name: string | null;
  /**
   * Display name for the seller. COALESCE(sv_links.discord_username, sv_links.discord_global_name, sv_links.discord_id).
   * Falls back to the snowflake ID for rows the username backfill hasn't reached yet. Null if seller is not linked.
   */
  seller_discord_name: string | null;
  /**
   * Display name for the buyer. Same COALESCE strategy as `seller_discord_name`.
   * Null if not bought yet or buyer is not linked.
   */
  buyer_discord_name: string | null;
}

export interface CreateListingInput {
  vaultName: string;
  itemIndex: number;
  price: number;
}

export interface ListingsFilter {
  item_id?: number;
  type_id?: number;
  seller?: string;
  status?: P2PStatus;
  min_price?: number;
  max_price?: number;
  page?: number;
  limit?: number;
}
