import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { SchedulerRegistry } from '@nestjs/schedule';
import { CronJob } from 'cron';
import { DbService } from '../database/db.service';

@Injectable()
export class TaxService implements OnModuleInit {
  private readonly log = new Logger(TaxService.name);

  constructor(
    private readonly cfg: ConfigService,
    private readonly db: DbService,
    private readonly scheduler: SchedulerRegistry,
  ) {}

  onModuleInit() {
    const tax = this.cfg.get<{ percent: number; threshold: number; cron: string }>('wealthTax')!;
    if (tax.percent <= 0) {
      this.log.log('Wealth tax disabled (percent <= 0)');
      return;
    }
    const job = new CronJob(tax.cron, () => {
      this.runOnce().catch(e => this.log.error(e));
    });
    this.scheduler.addCronJob('wealthTax', job as any);
    job.start();
    this.log.log(`Wealth tax scheduled: cron='${tax.cron}', percent=${tax.percent}%, threshold=${tax.threshold}`);
  }

  /** Apply wealth tax once. Exposed so it can also be triggered manually (e.g. admin route). */
  async runOnce() {
    const { percent, threshold } = this.cfg.get<{ percent: number; threshold: number }>('wealthTax')!;
    if (percent <= 0) return { applied: 0, taxed: 0 };

    const coins = this.db.table('sv', 'coins');
    const activity = this.db.table('sv', 'activity_log');
    const conn = await this.db.getConnection();
    try {
      await conn.beginTransaction();

      // 1. Find all eligible players
      const [rows] = await conn.query(
        `SELECT steam_id, balance FROM ${coins} WHERE balance > ? FOR UPDATE`,
        [threshold],
      );
      const eligible = rows as { steam_id: string; balance: number }[];
      if (eligible.length === 0) {
        await conn.commit();
        this.log.log(`Wealth tax tick: 0 players above threshold (${threshold})`);
        return { applied: 0, taxed: 0 };
      }

      // 2. Compute & deduct per-player
      let totalTaxed = 0;
      for (const r of eligible) {
        const bal = Number(r.balance);
        const tax = Math.floor(bal * percent / 100);
        if (tax <= 0) continue;
        await conn.query(
          `UPDATE ${coins} SET balance = balance - ? WHERE steam_id = ? AND balance >= ?`,
          [tax, r.steam_id, tax],
        );
        await conn.query(
          `INSERT INTO ${activity} (steam_id, kind, coins) VALUES (?, 'tax', ?)`,
          [r.steam_id, -tax],
        );
        totalTaxed += tax;
      }

      await conn.commit();
      this.log.log(`Wealth tax applied: ${eligible.length} players, total ${totalTaxed} coins`);
      return { applied: eligible.length, taxed: totalTaxed };
    } catch (e) {
      try { await conn.rollback(); } catch {}
      throw e;
    } finally {
      conn.release();
    }
  }
}
