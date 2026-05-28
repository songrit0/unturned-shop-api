import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { SchedulerRegistry } from '@nestjs/schedule';
import { CronJob } from 'cron';
import { P2pService } from './p2p.service';

/**
 * Periodic sweep that expires `active` listings older than P2P_TTL_DAYS.
 * Each expired listing is closed via P2pService.expireOne which returns the item
 * to the seller's default vault and writes a `expire` log row.
 *
 * Overlap protection: a running tick skips re-entry; the next cron firing logs
 * and noops until the previous tick finishes.
 */
@Injectable()
export class P2pExpireService implements OnModuleInit {
  private readonly log = new Logger(P2pExpireService.name);
  private running = false;

  constructor(
    private readonly cfg: ConfigService,
    private readonly scheduler: SchedulerRegistry,
    private readonly p2p: P2pService,
  ) {}

  onModuleInit() {
    const p2pCfg = this.cfg.get<{ ttlDays: number; expireCron: string }>('p2p')!;
    if (!p2pCfg.expireCron || p2pCfg.ttlDays <= 0) {
      this.log.log(`P2P expire cron disabled (cron='${p2pCfg.expireCron}', ttlDays=${p2pCfg.ttlDays})`);
      return;
    }
    const job = new CronJob(p2pCfg.expireCron, () => {
      this.runOnce().catch((e) => this.log.error(e));
    });
    this.scheduler.addCronJob('p2pExpire', job as any);
    job.start();
    this.log.log(`P2P expire scheduled: cron='${p2pCfg.expireCron}', ttlDays=${p2pCfg.ttlDays}`);
  }

  /** One sweep. Re-entrant-safe via the `running` flag. */
  async runOnce(): Promise<{ scanned: number; expired: number; skipped?: boolean }> {
    if (this.running) {
      this.log.warn('P2P expire tick skipped: previous tick still running');
      return { scanned: 0, expired: 0, skipped: true };
    }
    this.running = true;
    const startedAt = Date.now();
    try {
      const { ttlDays } = this.cfg.get<{ ttlDays: number }>('p2p')!;
      const candidates = await this.p2p.findExpired(ttlDays, 200);
      this.log.log(`P2P expire tick start: ${candidates.length} candidate(s) older than ${ttlDays}d`);
      let expired = 0;
      for (const row of candidates) {
        try {
          await this.p2p.expireOne(Number(row.id));
          expired += 1;
        } catch (e: any) {
          this.log.warn(`P2P expire tick: listing ${row.id} failed: ${e.message}`);
        }
      }
      const ms = Date.now() - startedAt;
      this.log.log(`P2P expire tick end: scanned=${candidates.length} expired=${expired} (${ms}ms)`);
      return { scanned: candidates.length, expired };
    } finally {
      this.running = false;
    }
  }
}
