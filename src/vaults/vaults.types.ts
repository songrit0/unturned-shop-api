/** Raw item shape as serialized inside MySQLVault's `Vaults.Data` JSON array.
 *  Keys match the plugin format exactly — never rename or re-case. */
export interface VaultItem {
  X: number;
  Y: number;
  Rot: number;
  Amount: number;
  Quality: number;
  /** Base64 internal state (mag/attachments/ammo). Opaque. Must be round-tripped verbatim. */
  State: string;
  Id: number;
}

import { GunView } from '../p2p/gun-state';

/** Item plus joined metadata from sv_items, returned on read endpoints. */
export interface VaultItemView extends VaultItem {
  name: string | null;
  description: string | null;
  image_url: string | null;
  type_id: number | null;
  type_name: string | null;
  /**
   * Parsed gun attachments + ammo when `State` decodes as a gun.
   * Null when the state doesn't parse as a gun (e.g. a magazine stack with empty state).
   */
  gun: GunView | null;
}

export interface VaultSummary {
  owner_steam: string;
  owner_name: string | null;
  name: string;
  item_count: number;
  last_update: Date | null;
}

export interface VaultDetail extends VaultSummary {
  items: VaultItemView[];
}
