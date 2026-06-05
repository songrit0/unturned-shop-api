import { BadRequestException, Injectable } from '@nestjs/common';
import { DbService } from '../database/db.service';
import { MeowcoinWalletService } from '../topup/meowcoin-wallet.service';

export type VipCurrency = 'coin' | 'meowcoin';

export interface VipPackagePublic {
  id: number;
  tier: string;
  group_id: string;
  days: number;
  price_coins: number;
  /** Meowcoin price, or null when this package is not buyable with Meowcoin. */
  price_meowcoins: number | null;
  label: string | null;
  sort: number;
}

export interface VipGrantPublic {
  group_id: string;
  expires_at: Date;
}

export interface VipBuyResult {
  ok: true;
  tier: string;
  group_id: string;
  days: number;
  price: number;
  currency: VipCurrency;
  balance: number;            // remaining balance in the currency that was charged
  expires_at: Date;
}

/**
 * Player-facing VIP purchasing with coins (web). Same transactional buy as the Discord /vipshop:
 * verify enabled package -> check coins -> deduct -> extend grant -> log. The VIP plugin applies the
 * RocketMod group on its next reconcile. All sv_vip_* times are UTC.
 */
@Injectable()
export class VipService {
  constructor(
    private readonly db: DbService,
    private readonly wallet: MeowcoinWalletService,
  ) {}

  private pkgT() { return this.db.table('sv', 'vip_packages'); }
  private grantT() { return this.db.table('sv', 'vip_grants'); }
  private logT() { return this.db.table('sv', 'vip_log'); }
  private coinsT() { return this.db.table('sv', 'coins'); }

  listEnabled(): Promise<VipPackagePublic[]> {
    return this.db.query<VipPackagePublic>(
      `SELECT id, tier, group_id, days, price_coins, price_meowcoins, label, sort
       FROM ${this.pkgT()} WHERE enabled = 1 ORDER BY sort ASC, price_coins ASC`,
    );
  }

  grantsForSteam(steamId: string): Promise<VipGrantPublic[]> {
    return this.db.query<VipGrantPublic>(
      `SELECT group_id, expires_at FROM ${this.grantT()}
       WHERE steam_id = ? AND active = 1 AND expires_at > UTC_TIMESTAMP()
       ORDER BY expires_at DESC`,
      [steamId],
    );
  }

  async buy(steamId: string, packageId: number, currency: VipCurrency = 'coin'): Promise<VipBuyResult> {
    return currency === 'meowcoin'
      ? this.buyMeowcoin(steamId, packageId)
      : this.buyCoin(steamId, packageId);
  }

  /** Extend (or create) the VIP grant for a package, then log the buy. Runs in the caller's txn. */
  private async grantAndLog(
    conn: any,
    steamId: string,
    groupId: string,
    days: number,
  ): Promise<Date> {
    await conn.query(
      `INSERT INTO ${this.grantT()} (steam_id, group_id, expires_at, active)
       VALUES (?, ?, DATE_ADD(UTC_TIMESTAMP(), INTERVAL ? DAY), 1)
       ON DUPLICATE KEY UPDATE
         expires_at = DATE_ADD(GREATEST(UTC_TIMESTAMP(),
           CASE WHEN active = 1 THEN expires_at ELSE UTC_TIMESTAMP() END), INTERVAL ? DAY),
         active = 1`,
      [steamId, groupId, days, days],
    );
    const [expRows] = await conn.query(
      `SELECT expires_at FROM ${this.grantT()} WHERE steam_id = ? AND group_id = ? LIMIT 1`,
      [steamId, groupId],
    );
    const expires_at = (expRows as any[])[0]?.expires_at;
    await conn.query(
      `INSERT INTO ${this.logT()} (steam_id, group_id, action, days, actor) VALUES (?, ?, 'buy', ?, 'web')`,
      [steamId, groupId, days],
    );
    return expires_at;
  }

  /** Buy with in-game Coin (sv_coins) — single shop-DB transaction. UNCHANGED behaviour. */
  private async buyCoin(steamId: string, packageId: number): Promise<VipBuyResult> {
    const conn = await this.db.getConnection();
    try {
      await conn.beginTransaction();

      const [pkgRows] = await conn.query(
        `SELECT id, tier, group_id, days, price_coins FROM ${this.pkgT()} WHERE id = ? AND enabled = 1 FOR UPDATE`,
        [packageId],
      );
      const pkg = (pkgRows as any[])[0];
      if (!pkg) { await conn.rollback(); throw new BadRequestException('แพ็กเกจนี้ปิดอยู่หรือไม่พบ'); }

      const price = Number(pkg.price_coins);
      const days = Number(pkg.days);
      const groupId = pkg.group_id as string;

      // price_coins <= 0 means this package is not sold with Coin (e.g. Meowcoin-only).
      if (!(price > 0)) { await conn.rollback(); throw new BadRequestException('coin_not_available'); }

      // ensure a coins row exists, then lock it
      await conn.query(
        `INSERT INTO ${this.coinsT()} (steam_id, balance) VALUES (?, 0) ON DUPLICATE KEY UPDATE balance = balance`,
        [steamId],
      );
      const [balRows] = await conn.query(`SELECT balance FROM ${this.coinsT()} WHERE steam_id = ? FOR UPDATE`, [steamId]);
      const balance = (balRows as any[])[0] ? Number((balRows as any[])[0].balance) : 0;
      if (balance < price) {
        await conn.rollback();
        throw new BadRequestException(`Coin ไม่พอ — ต้องใช้ ${price} แต่มี ${balance}`);
      }

      await conn.query(`UPDATE ${this.coinsT()} SET balance = balance - ? WHERE steam_id = ?`, [price, steamId]);

      const expires_at = await this.grantAndLog(conn, steamId, groupId, days);

      await conn.commit();
      return { ok: true, tier: pkg.tier, group_id: groupId, days, price, currency: 'coin', balance: balance - price, expires_at };
    } catch (e) {
      try { await conn.rollback(); } catch {}
      throw e;
    } finally {
      conn.release();
    }
  }

  /**
   * Buy with Meowcoin (Pi5 wallet). SAGA across two DBs (no shared txn):
   *   (a) open shop txn, lock the package, upsert grant + log (NO sv_coins deduct), keep it open.
   *   (b) debit Meowcoin (atomic guard) — insufficient -> rollback shop txn, throw insufficient_meowcoin.
   *   (c) commit shop txn — on commit failure, refund() the Meowcoin then rethrow.
   * Returns the remaining Meowcoin balance as `balance`.
   */
  private async buyMeowcoin(steamId: string, packageId: number): Promise<VipBuyResult> {
    const conn = await this.db.getConnection();
    let committed = false;
    let price = 0;
    let refKey = `vip:${packageId}`;
    try {
      await conn.beginTransaction();

      const [pkgRows] = await conn.query(
        `SELECT id, tier, group_id, days, price_coins, price_meowcoins FROM ${this.pkgT()} WHERE id = ? AND enabled = 1 FOR UPDATE`,
        [packageId],
      );
      const pkg = (pkgRows as any[])[0];
      if (!pkg) { await conn.rollback(); throw new BadRequestException('แพ็กเกจนี้ปิดอยู่หรือไม่พบ'); }
      if (pkg.price_meowcoins == null) { await conn.rollback(); throw new BadRequestException('no_meowcoin_price'); }

      price = Math.trunc(Number(pkg.price_meowcoins));
      const days = Number(pkg.days);
      const groupId = pkg.group_id as string;

      const expires_at = await this.grantAndLog(conn, steamId, groupId, days);

      // Debit Meowcoin from the Pi5 wallet (atomic guard). Insufficient -> roll the shop txn back.
      try {
        await this.wallet.debit(steamId, price, 'vip_buy', refKey);
      } catch (e: any) {
        await conn.rollback();
        if (e?.response?.message === 'insufficient_meowcoin' || e?.message === 'insufficient_meowcoin') {
          throw new BadRequestException('insufficient_meowcoin');
        }
        throw e;
      }

      // Commit the shop txn. If THIS fails, the Meowcoin was already taken -> compensate.
      try {
        await conn.commit();
        committed = true;
      } catch (commitErr) {
        await this.wallet.refund(steamId, price, 'vip_buy_refund', refKey).catch(() => {});
        throw commitErr;
      }

      const balance = await this.wallet.balanceOf(steamId);
      return { ok: true, tier: pkg.tier, group_id: groupId, days, price, currency: 'meowcoin', balance, expires_at };
    } catch (e) {
      if (!committed) { try { await conn.rollback(); } catch {} }
      throw e;
    } finally {
      conn.release();
    }
  }
}
