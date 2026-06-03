import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  HttpException,
  HttpStatus,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as mysql from 'mysql2/promise';
import { DbService } from '../database/db.service';
import { Paginated, normalizePage } from '../common/pagination';
import {
  CreateGarageListingInput,
  GarageListingRow,
  GarageListingView,
  GarageListingsFilter,
  MineVehicleView,
} from './p2p-garage.types';

@Injectable()
export class P2pGarageService {
  private readonly log = new Logger(P2pGarageService.name);

  constructor(
    private readonly db: DbService,
    private readonly cfg: ConfigService,
  ) {}

  private listingsTbl() { return this.db.table('sv', 'p2p_garage_listings'); }
  private linksTbl()    { return this.db.table('sv', 'links'); }
  private coinsTbl()    { return this.db.table('sv', 'coins'); }
  private vehiclesTbl() { return this.db.table('sv', 'vehicles'); }
  /** The unprefixed, plugin-owned VirtualGarage table (db.garageTable). */
  private garageTbl()   { return this.db.garageTableRaw(); }

  /** Commission percent applied to the buyer's payment; seller receives (1 - pct/100) * price. */
  private commissionPct(): number {
    const v = Number(this.cfg.get<number>('p2p.commissionPercent') ?? 5);
    if (!Number.isFinite(v) || v < 0) return 0;
    return Math.min(100, v);
  }

  /** The caller's garage rows available to list (vehicle_name/image_url from sv_vehicles by legacy_id). */
  async mineVehicles(sellerSteam: string): Promise<MineVehicleView[]> {
    return this.db.query<MineVehicleView>(
      `SELECT g.id AS garage_id, g.name AS name, g.legacy_id AS legacy_id,
              g.listed_for_sale AS listed_for_sale,
              v.name AS vehicle_name, v.image_url AS image_url
       FROM ${this.garageTbl()} g
       LEFT JOIN ${this.vehiclesTbl()} v ON v.id = g.legacy_id
       WHERE g.steam_id = ?
       ORDER BY g.id ASC`,
      [sellerSteam],
    );
  }

  async listActive(filters: GarageListingsFilter): Promise<Paginated<GarageListingView>> {
    const np = normalizePage(filters.page, filters.limit);
    const where: string[] = [];
    const params: any[] = [];

    const status = filters.status || 'active';
    where.push('l.status = ?'); params.push(status);
    if (filters.seller) { where.push('l.seller_steam = ?'); params.push(filters.seller); }
    const whereSql = where.length ? where.join(' AND ') : '1=1';

    const cntRow = await this.db.first<{ c: number }>(
      `SELECT COUNT(*) AS c FROM ${this.listingsTbl()} l WHERE ${whereSql}`,
      params,
    );
    const total = cntRow ? Number(cntRow.c) : 0;

    const rows = await this.db.query<GarageListingView>(
      `SELECT l.*, v.name AS vehicle_name, v.image_url,
              COALESCE(ls.discord_username, ls.discord_global_name, ls.discord_id) AS seller_discord_name,
              COALESCE(lb.discord_username, lb.discord_global_name, lb.discord_id) AS buyer_discord_name
       FROM ${this.listingsTbl()} l
       LEFT JOIN ${this.vehiclesTbl()} v ON v.id = l.legacy_id
       LEFT JOIN ${this.linksTbl()} ls ON ls.steam_id = l.seller_steam
       LEFT JOIN ${this.linksTbl()} lb ON lb.steam_id = l.buyer_steam
       WHERE ${whereSql}
       ORDER BY l.created_at DESC
       LIMIT ? OFFSET ?`,
      [...params, np.limit, np.offset],
    );
    return { items: rows, total, page: np.page, limit: np.limit, pages: Math.ceil(total / np.limit) };
  }

  async getListing(id: number): Promise<GarageListingView> {
    const row = await this.db.first<GarageListingView>(
      `SELECT l.*, v.name AS vehicle_name, v.image_url,
              COALESCE(ls.discord_username, ls.discord_global_name, ls.discord_id) AS seller_discord_name,
              COALESCE(lb.discord_username, lb.discord_global_name, lb.discord_id) AS buyer_discord_name
       FROM ${this.listingsTbl()} l
       LEFT JOIN ${this.vehiclesTbl()} v ON v.id = l.legacy_id
       LEFT JOIN ${this.linksTbl()} ls ON ls.steam_id = l.seller_steam
       LEFT JOIN ${this.linksTbl()} lb ON lb.steam_id = l.buyer_steam
       WHERE l.id = ?`,
      [id],
    );
    if (!row) throw new NotFoundException('Listing not found');
    return row;
  }

  async listingsForSeller(steamId: string, page?: number, limit?: number): Promise<Paginated<GarageListingView>> {
    const np = normalizePage(page, limit);
    const cntRow = await this.db.first<{ c: number }>(
      `SELECT COUNT(*) AS c FROM ${this.listingsTbl()} WHERE seller_steam = ?`, [steamId],
    );
    const total = cntRow ? Number(cntRow.c) : 0;
    const rows = await this.db.query<GarageListingView>(
      `SELECT l.*, v.name AS vehicle_name, v.image_url,
              COALESCE(ls.discord_username, ls.discord_global_name, ls.discord_id) AS seller_discord_name,
              COALESCE(lb.discord_username, lb.discord_global_name, lb.discord_id) AS buyer_discord_name
       FROM ${this.listingsTbl()} l
       LEFT JOIN ${this.vehiclesTbl()} v ON v.id = l.legacy_id
       LEFT JOIN ${this.linksTbl()} ls ON ls.steam_id = l.seller_steam
       LEFT JOIN ${this.linksTbl()} lb ON lb.steam_id = l.buyer_steam
       WHERE l.seller_steam = ?
       ORDER BY l.created_at DESC
       LIMIT ? OFFSET ?`,
      [steamId, np.limit, np.offset],
    );
    return { items: rows, total, page: np.page, limit: np.limit, pages: Math.ceil(total / np.limit) };
  }

  /**
   * List a garage vehicle for sale: lock it (listed_for_sale=1) and persist an active listing.
   * Ownership stays with the seller until a buy transfers it. Holds the virtual_garage row
   * FOR UPDATE for the duration of the transaction.
   */
  async createListing(sellerSteam: string, input: CreateGarageListingInput): Promise<GarageListingView> {
    if (!Number.isFinite(input.price) || input.price <= 0) {
      throw new BadRequestException('price must be > 0');
    }
    const conn = await this.db.getConnection();
    let listingId: number;
    try {
      await conn.beginTransaction();
      try {
        const [grows] = await conn.query<mysql.RowDataPacket[]>(
          `SELECT id, steam_id, name, legacy_id, listed_for_sale
             FROM ${this.garageTbl()} WHERE id = ? FOR UPDATE`,
          [input.garageId],
        );
        const garage = grows[0] as
          | { id: number; steam_id: string; name: string; legacy_id: number | null; listed_for_sale: number }
          | undefined;
        if (!garage) { await conn.rollback(); throw new NotFoundException('garage_vehicle_not_found'); }
        if (String(garage.steam_id) !== sellerSteam) {
          await conn.rollback();
          throw new ForbiddenException('not_owner');
        }
        if (Number(garage.listed_for_sale) !== 0) {
          await conn.rollback();
          throw new ConflictException('already_listed');
        }

        // Defensive: no existing active listing for this garage_id (one active listing per Virtual).
        const [arows] = await conn.query<mysql.RowDataPacket[]>(
          `SELECT id FROM ${this.listingsTbl()} WHERE garage_id = ? AND status = 'active' LIMIT 1`,
          [input.garageId],
        );
        if (arows.length > 0) {
          await conn.rollback();
          throw new ConflictException('already_listed');
        }

        const legacyId = garage.legacy_id != null ? Number(garage.legacy_id) : 0;

        await conn.query(
          `UPDATE ${this.garageTbl()} SET listed_for_sale = 1 WHERE id = ?`,
          [input.garageId],
        );
        const [ins] = await conn.query<mysql.ResultSetHeader>(
          `INSERT INTO ${this.listingsTbl()}
             (seller_steam, garage_id, garage_name, legacy_id, price, status)
           VALUES (?, ?, ?, ?, ?, 'active')`,
          [sellerSteam, input.garageId, garage.name, legacyId, input.price],
        );
        listingId = Number(ins.insertId);
        await conn.commit();
      } catch (e) {
        try { await conn.rollback(); } catch { /* ignore */ }
        throw e;
      }
    } finally {
      conn.release();
    }
    return this.getListing(listingId);
  }

  /**
   * Buyer purchases an active garage listing. Atomic across:
   * - Lock listing row (status check)
   * - Require the buyer's garage to be EMPTY (UNIQUE(steam_id,name) + one-vehicle garage rule)
   * - Lock the virtual_garage row; it must still be owned by the seller and listed
   * - Debit buyer's sv_coins (full price), credit seller (price - commission)
   * - Transfer ownership: virtual_garage.steam_id = buyer, listed_for_sale = 0
   * - Mark listing sold
   * No redeem code, no purchase row, no claim.
   */
  async buyListing(buyerSteam: string, listingId: number): Promise<GarageListingView> {
    const conn = await this.db.getConnection();
    try {
      await conn.beginTransaction();
      try {
        // 1) Lock listing
        const [lrows] = await conn.query<mysql.RowDataPacket[]>(
          `SELECT * FROM ${this.listingsTbl()} WHERE id = ? FOR UPDATE`, [listingId],
        );
        const listing = lrows[0] as GarageListingRow | undefined;
        if (!listing) { await conn.rollback(); throw new NotFoundException('Listing not found'); }
        if (listing.status !== 'active') {
          await conn.rollback();
          throw new ConflictException('listing_no_longer_active');
        }
        if (listing.seller_steam === buyerSteam) {
          await conn.rollback();
          throw new BadRequestException('cannot_buy_own_listing');
        }

        // 2) Buyer must have an empty garage (UNIQUE(steam_id,name) would clash otherwise).
        const [crows] = await conn.query<mysql.RowDataPacket[]>(
          `SELECT COUNT(*) AS c FROM ${this.garageTbl()} WHERE steam_id = ?`, [buyerSteam],
        );
        const garageCount = crows[0] ? Number((crows[0] as any).c) : 0;
        if (garageCount > 0) {
          await conn.rollback();
          throw new BadRequestException('buyer_garage_not_empty');
        }

        // 3) Lock the garage row; it must still be owned by the seller and listed.
        const [grows] = await conn.query<mysql.RowDataPacket[]>(
          `SELECT id, steam_id, listed_for_sale FROM ${this.garageTbl()} WHERE id = ? FOR UPDATE`,
          [listing.garage_id],
        );
        const garage = grows[0] as { id: number; steam_id: string; listed_for_sale: number } | undefined;
        if (!garage || String(garage.steam_id) !== listing.seller_steam || Number(garage.listed_for_sale) !== 1) {
          // Vehicle gone/moved — close listing best-effort and reject.
          await conn.query(
            `UPDATE ${this.listingsTbl()} SET status='cancelled', closed_at=NOW() WHERE id = ? AND status='active'`,
            [listingId],
          );
          await conn.commit();
          throw new ConflictException('garage_vehicle_gone');
        }

        const price = Number(listing.price);
        const commission = Math.round((price * this.commissionPct() / 100));
        const sellerProceeds = Math.max(0, Math.round(price) - commission);

        // 4) Debit buyer (atomic: UPDATE ... WHERE balance >= price)
        const [debit] = await conn.query<mysql.ResultSetHeader>(
          `UPDATE ${this.coinsTbl()} SET balance = balance - ? WHERE steam_id = ? AND balance >= ?`,
          [Math.round(price), buyerSteam, Math.round(price)],
        );
        if (debit.affectedRows === 0) {
          await conn.rollback();
          throw new HttpException('insufficient_funds', HttpStatus.PAYMENT_REQUIRED);
        }

        // Credit seller (upsert: row may not exist)
        await conn.query(
          `INSERT INTO ${this.coinsTbl()} (steam_id, balance) VALUES (?, ?)
           ON DUPLICATE KEY UPDATE balance = balance + VALUES(balance)`,
          [listing.seller_steam, sellerProceeds],
        );

        // 5) Transfer ownership + unlock.
        await conn.query(
          `UPDATE ${this.garageTbl()} SET steam_id = ?, listed_for_sale = 0 WHERE id = ?`,
          [buyerSteam, listing.garage_id],
        );

        // 6) Close listing.
        await conn.query(
          `UPDATE ${this.listingsTbl()} SET status='sold', buyer_steam=?, closed_at=NOW() WHERE id = ?`,
          [buyerSteam, listingId],
        );

        await conn.commit();
      } catch (e) {
        try { await conn.rollback(); } catch { /* ignore */ }
        throw e;
      }
    } finally {
      conn.release();
    }
    return this.getListing(listingId);
  }

  /** Seller cancels — unlock the garage vehicle (it never left the garage; no refund code). */
  async cancelListing(sellerSteam: string, listingId: number): Promise<GarageListingView> {
    return this.closeAndUnlock(listingId, sellerSteam);
  }

  /** Admin force-close — unlock the garage vehicle, skipping the seller-match check. */
  async adminForceClose(listingId: number): Promise<GarageListingView> {
    return this.closeAndUnlock(listingId, null);
  }

  /**
   * Shared close path. Unlocks the garage vehicle (best-effort even if the row moved) and marks
   * the listing cancelled. The vehicle never left the garage, so there is no refund code.
   * @param requireSellerMatch — if non-null, the caller must equal seller_steam (cancel flow).
   */
  private async closeAndUnlock(
    listingId: number,
    requireSellerMatch: string | null,
  ): Promise<GarageListingView> {
    const conn = await this.db.getConnection();
    try {
      await conn.beginTransaction();
      try {
        const [lrows] = await conn.query<mysql.RowDataPacket[]>(
          `SELECT * FROM ${this.listingsTbl()} WHERE id = ? FOR UPDATE`, [listingId],
        );
        const listing = lrows[0] as GarageListingRow | undefined;
        if (!listing) { await conn.rollback(); throw new NotFoundException('Listing not found'); }
        if (listing.status !== 'active') {
          await conn.rollback();
          throw new ConflictException('listing_no_longer_active');
        }
        if (requireSellerMatch && listing.seller_steam !== requireSellerMatch) {
          await conn.rollback();
          throw new ForbiddenException('not_listing_owner');
        }

        // Unlock the garage vehicle (best-effort even if the row moved/was deleted).
        await conn.query(
          `UPDATE ${this.garageTbl()} SET listed_for_sale = 0 WHERE id = ?`,
          [listing.garage_id],
        );
        await conn.query(
          `UPDATE ${this.listingsTbl()} SET status='cancelled', closed_at=NOW() WHERE id = ?`,
          [listingId],
        );
        await conn.commit();
      } catch (e) {
        try { await conn.rollback(); } catch { /* ignore */ }
        throw e;
      }
    } finally {
      conn.release();
    }
    return this.getListing(listingId);
  }
}
