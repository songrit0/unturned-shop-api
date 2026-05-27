import { Global, Module } from '@nestjs/common';
import { MarketHistoryService } from './market-history.service';
import { MarketHistoryCronService } from './market-history-cron.service';

@Global()
@Module({
  providers: [MarketHistoryService, MarketHistoryCronService],
  exports: [MarketHistoryService],
})
export class MarketHistoryModule {}
