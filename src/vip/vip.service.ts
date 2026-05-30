import { BadRequestException, Injectable } from '@nestjs/common';
import { DbService } from '../database/db.service';

export interface VipPackagePublic {
  id: number;
  tier: string;
  group_id: string;
  days: number;
  price_coins: number;
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
  balance: number;
  expires_at: Date;
}

/**
 * Player-facing VIP purchasing with coins (web). Same transactional buy as the Discord /vipshop:
 * verify enabled package -> check coins -> deduct -> extend grant -> log. The VIP plugin applies the
 * RocketMod group on its next reconcile. All sv_vip_* times are UTC.
 */
@Injectable()
export class VipService {
  constructor(private readonly db: DbService) {}

  private pkgT() { return this.db.table('sv', 'vip_packages'); }
  private grantT() { return this.db.table('sv', 'vip_grants'); }
  private logT() { return this.db.table('sv', 'vip_log'); }
  private coinsT() { return this.db.table('sv', 'coins'); }

  listEnabled(): Promise<VipPackagePublic[]> {
    return this.db.query<VipPackagePublic>(
      `SELECT id, tier, group_id, days, price_coins, label, sort
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

  async buy(steamId: string, packageId: number): Promise<VipBuyResult> {
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

      await conn.commit();
      return { ok: true, tier: pkg.tier, group_id: groupId, days, price, balance: balance - price, expires_at };
    } catch (e) {
      try { await conn.rollback(); } catch {}
      throw e;
    } finally {
      conn.release();
    }
  }
}
