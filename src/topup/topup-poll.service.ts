import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { SchedulerRegistry } from '@nestjs/schedule';
import { CronJob } from 'cron';
import { PlernpayService } from './plernpay.service';
import { TopupService } from './topup.service';

/**
 * Authoritative credit path. Every ~15s it polls the oldest PENDING top-ups against PlernPay.
 * PlernPay rate-limits at 30 req/min per key, so the per-tick batch is capped (default 5 polls
 * + a small number of best-effort cancels => comfortably under the limit even at 4 ticks/min).
 *
 * - confirmed -> TopupService.confirmAndCredit (one Pi5 txn, idempotent via status guard).
 * - past expiry & still pending -> mark expired (+ best-effort gateway cancel).
 *
 * Re-entrant-safe: a tick that overruns 15s is skipped rather than overlapped.
 */
@Injectable()
export class TopupPollService implements OnModuleInit {
  private readonly log = new Logger(TopupPollService.name);
  private running = false;

  constructor(
    private readonly cfg: ConfigService,
    private readonly scheduler: SchedulerRegistry,
    private readonly topup: TopupService,
    private readonly plernpay: PlernpayService,
  ) {}

  onModuleInit() {
    const cron = this.cfg.get<string>('topup.pollCron') || '*/15 * * * * *';
    const job = new CronJob(cron, () => {
      this.runOnce().catch((e) => this.log.error(e));
    });
    this.scheduler.addCronJob('topupPoll', job as any);
    job.start();
    this.log.log(`Top-up poller scheduled: cron='${cron}'`);
  }

  /** One poll sweep. Re-entrant-safe via the `running` flag. */
  async runOnce(): Promise<{ polled: number; credited: number; expired: number; skipped?: boolean }> {
    if (this.running) {
      this.log.warn('Top-up poll tick skipped: previous tick still running');
      return { polled: 0, credited: 0, expired: 0, skipped: true };
    }
    this.running = true;
    try {
      const batch = Math.max(1, Number(this.cfg.get<number>('topup.pollBatch') ?? 5));

      // 1) Sweep already-expired pending rows first (cheap, no gateway poll needed to expire).
      let expired = 0;
      const stale = await this.topup.findExpiredPending(batch);
      for (const row of stale) {
        try {
          await this.topup.markExpired(row.ref);
          // Only PlernPay has a gateway charge to cancel; Thunder rows just get marked expired.
          if (row.provider === 'plernpay') {
            await this.plernpay.cancelTopup(row.ref); // best-effort
          }
          expired += 1;
        } catch (e: any) {
          this.log.warn(`Top-up expire ${row.ref} failed: ${e.message}`);
        }
      }

      // 2) Poll the oldest still-pending, not-yet-expired rows (capped to stay under 30/min).
      let polled = 0;
      let credited = 0;
      const pending = await this.topup.findPollable(batch);
      for (const row of pending) {
        try {
          const res = await this.plernpay.getTopup(row.ref);
          polled += 1;
          if (res.status === 'confirmed') {
            const didCredit = await this.topup.confirmAndCredit(row);
            if (didCredit) {
              credited += 1;
              this.log.log(`Top-up credited: ref=${row.ref} steam=${row.steam_id} +${row.meowcoins} meowcoins`);
            }
          } else if (res.status === 'expired' || res.status === 'cancelled') {
            await this.topup.markExpired(row.ref);
          }
          // 'pending' -> leave as-is for the next tick.
        } catch (e: any) {
          this.log.warn(`Top-up poll ${row.ref} failed: ${e.message}`);
        }
      }

      if (polled || credited || expired) {
        this.log.log(`Top-up poll tick: polled=${polled} credited=${credited} expired=${expired}`);
      }
      return { polled, credited, expired };
    } finally {
      this.running = false;
    }
  }
}
