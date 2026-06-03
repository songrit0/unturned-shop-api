export type GarageListingStatus = 'active' | 'sold' | 'cancelled';

/** A row in the api-owned sv_p2p_garage_listings table. */
export interface GarageListingRow {
  id: number;
  seller_steam: string;
  /** References virtual_garage.id (cross-plugin, no hard FK). */
  garage_id: number;
  /** Snapshot of virtual_garage.name at list time. */
  garage_name: string;
  /** Snapshot of virtual_garage.legacy_id at list time (0 when the row had none). */
  legacy_id: number;
  price: number;
  status: GarageListingStatus;
  buyer_steam: string | null;
  created_at: Date;
  closed_at: Date | null;
}

export interface GarageListingView extends GarageListingRow {
  /** sv_vehicles.name resolved by legacy_id, or null when not in the catalog. */
  vehicle_name: string | null;
  /** sv_vehicles.image_url resolved by legacy_id, or null when not in the catalog. */
  image_url: string | null;
  /**
   * Display name for the seller. COALESCE(sv_links.discord_username, sv_links.discord_global_name, sv_links.discord_id).
   * Null if the seller is not linked.
   */
  seller_discord_name: string | null;
  /** Display name for the buyer. Same COALESCE strategy. Null if not bought yet or buyer is not linked. */
  buyer_discord_name: string | null;
}

/** One of the caller's garage rows that is available to list on P2P. */
export interface MineVehicleView {
  garage_id: number;
  name: string;
  legacy_id: number;
  listed_for_sale: number;
  vehicle_name: string | null;
  image_url: string | null;
}

export interface CreateGarageListingInput {
  garageId: number;
  price: number;
}

export interface GarageListingsFilter {
  status?: GarageListingStatus;
  seller?: string;
  page?: number;
  limit?: number;
}
