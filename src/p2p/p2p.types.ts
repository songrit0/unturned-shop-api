import { GunView } from './gun-state';

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
  /**
   * When true, this listing has no single item: `item_id`=0 (sentinel), `amount`=child count,
   * and the real items live in `sv_p2p_listing_items` (see `P2PListingItemRow`). Used for
   * fill-type items (magazines, fuel cans...) with different per-item fill levels sold together
   * for one price.
   */
  is_bundle: boolean | number;
}

export interface P2PListingItemRow {
  id: number;
  listing_id: number;
  item_id: number;
  amount: number;
  quality: number;
  state: string;
  // Joined from sv_items on the read path so the web can render bundle contents.
  item_name?: string | null;
  image_url?: string | null;
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
  /**
   * Parsed gun attachments + ammo when the held item's `state` decodes as a gun.
   * Null when the state doesn't parse as a gun (e.g. a magazine stack with empty state).
   */
  gun: GunView | null;
  /**
   * Child items when `is_bundle` is true (one row per physical item, exact captured
   * amount/quality/state preserved). Null/omitted for plain listings.
   */
  bundleItems?: P2PListingItemRow[];
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
