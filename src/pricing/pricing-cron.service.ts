import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { SchedulerRegistry } from '@nestjs/schedule';
import { CronJob } from 'cron';
import { ConfigService } from '@nestjs/config';
import { PricingService } from './pricing.service';

@Injectable()
export class PricingCronService implements OnModuleInit {
  private readonly log = new Logger(PricingCronService.name);

  constructor(
    private readonly cfg: ConfigService,
    private readonly pricing: PricingService,
    private readonly scheduler: SchedulerRegistry,
  ) {}

  onModuleInit() {
    const cron = process.env.PRICING_RECOMPUTE_CRON || '*/30 * * * * *'; // every 30 seconds
    const job = new CronJob(cron, () => {
      this.pricing.recomputeAll().catch(e => this.log.warn(`recompute failed: ${e.message}`));
    });
    this.scheduler.addCronJob('pricingRecompute', job as any);
    job.start();
    this.log.log(`Pricing cron: '${cron}'`);
  }
}
