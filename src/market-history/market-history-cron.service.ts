import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { SchedulerRegistry } from '@nestjs/schedule';
import { CronJob } from 'cron';
import { MarketHistoryService } from './market-history.service';

@Injectable()
export class MarketHistoryCronService implements OnModuleInit {
  private readonly log = new Logger(MarketHistoryCronService.name);

  constructor(
    private readonly history: MarketHistoryService,
    private readonly scheduler: SchedulerRegistry,
  ) {}

  onModuleInit() {
    const cron = process.env.HISTORY_CLEANUP_CRON || '0 3 * * *';
    const job = new CronJob(cron, () => {
      this.history.cleanup()
        .then((n) => { if (n > 0) this.log.log(`market_price_history cleanup deleted ${n} row(s)`); })
        .catch((e) => this.log.warn(`history cleanup failed: ${e.message}`));
    });
    this.scheduler.addCronJob('marketHistoryCleanup', job as any);
    job.start();
    this.log.log(`Market history cleanup cron: '${cron}'`);
  }
}
