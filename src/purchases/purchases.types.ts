export interface PurchaseRow {
  id: number;
  buyer_steam: string;
  listing_id: number;
  item_id: number;
  amount: number;
  quality: number;
  state: string;
  rot: number;
  purchased_at: Date;
  claimed_at: Date | null;
  redeem_code: string | null;
}

export interface PurchaseView extends PurchaseRow {
  item_name: string | null;
  image_url: string | null;
  type_id: number | null;
  type_name: string | null;
}

export type PurchaseFilter = 'unclaimed' | 'claimed' | 'all';

export interface ClaimAllItem {
  item_id: number;
  item_name: string;
  amount: number;
  quality: number;
}

export interface ClaimAllResult {
  /** The single shared redeem code, or null when nothing was claimable. */
  redeem_code: string | null;
  /** Number of purchases claimed into the code. */
  count: number;
  items: ClaimAllItem[];
}
