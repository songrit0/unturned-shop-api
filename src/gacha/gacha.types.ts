export type GachaPrizeType = 'coins' | 'meowcoins' | 'item' | 'vehicle' | 'vip';

/** One configurable prize in the pool. `amount` meaning depends on `type`:
 *  coins/meowcoins → currency amount · item/vehicle → quantity · vip → days (0 = use package default). */
export interface GachaPrize {
  id: number;
  type: GachaPrizeType;
  ref_id: number | null;   // item_id / vehicle_id / vip_package_id (null for coins/meowcoins)
  amount: number;
  quality: number;         // item/vehicle quality 0-100
  weight: number;          // relative draw weight (>0)
  label: string | null;
  image_url: string | null;
  rarity: string | null;   // common | rare | epic | legendary (display only)
  enabled: boolean;
  sort: number;
}

export interface GachaConfig {
  enabled: boolean;
  base_free_spins: number;          // free spins everyone gets per day
  rank_bonus: Record<string, number>; // leaderboard rank → extra free spins, e.g. {"1":3,"2":2,"3":1}
  price_coins: number | null;       // coins to buy one spin (null = disabled)
  price_meowcoins: number | null;   // meowcoins to buy one spin (null = disabled)
  code_ttl_days: number;            // TTL for minted item/vehicle redeem codes
}

export interface GachaState {
  enabled: boolean;
  rank: number | null;       // leaderboard rank (1-based) or null if unranked
  freeEntitlement: number;   // total free spins earned today (base + rank bonus)
  freeUsed: number;
  freeRemaining: number;
  paidSpins: number;         // persistent bought-spin balance
  totalRemaining: number;    // freeRemaining + paidSpins
  priceCoins: number | null;
  priceMeowcoins: number | null;
  nextResetAt: string;       // ISO of the next 06:00 Thai reset
}

/** Result of a single spin — `code` set only for item/vehicle prizes. */
export interface GachaSpinResult {
  prize: {
    type: GachaPrizeType;
    label: string;
    amount: number;
    imageUrl: string | null;
    rarity: string | null;
    code: string | null;
  };
  remaining: number;
}

/** One entry in the "Top Today" feed. */
export interface GachaTodayEntry {
  name: string;
  prizeType: GachaPrizeType;
  prizeLabel: string;
  prizeAmount: number;
  imageUrl: string | null;
  rarity: string | null;
  at: string;
}
