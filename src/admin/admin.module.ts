import { Module } from '@nestjs/common';
import { AdminMarketController } from './admin-market.controller';
import { AdminMarketService } from './admin-market.service';
import { AdminCoinsController } from './admin-coins.controller';
import { AdminCoinsService } from './admin-coins.service';

@Module({
  controllers: [AdminMarketController, AdminCoinsController],
  providers: [AdminMarketService, AdminCoinsService],
})
export class AdminModule {}
