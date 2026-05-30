import { Module } from '@nestjs/common';
import { AdminMarketController } from './admin-market.controller';
import { AdminMarketService } from './admin-market.service';
import { AdminCoinsController } from './admin-coins.controller';
import { AdminCoinsService } from './admin-coins.service';
import { AdminVipController } from './admin-vip.controller';
import { AdminVipService } from './admin-vip.service';

@Module({
  controllers: [AdminMarketController, AdminCoinsController, AdminVipController],
  providers: [AdminMarketService, AdminCoinsService, AdminVipService],
  exports: [AdminMarketService],
})
export class AdminModule {}
