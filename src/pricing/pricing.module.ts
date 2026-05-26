import { Global, Module } from '@nestjs/common';
import { PricingService } from './pricing.service';
import { PricingCronService } from './pricing-cron.service';

@Global()
@Module({
  providers: [PricingService, PricingCronService],
  exports: [PricingService],
})
export class PricingModule {}
