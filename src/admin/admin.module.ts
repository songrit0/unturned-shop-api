import { Module } from '@nestjs/common';
import { AdminMarketController } from './admin-market.controller';
import { AdminMarketService } from './admin-market.service';
import { AdminCoinsController } from './admin-coins.controller';
import { AdminCoinsService } from './admin-coins.service';
import { AdminVipController } from './admin-vip.controller';
import { AdminVipService } from './admin-vip.service';
import { AdminVehicleMarketController } from './admin-vehicle-market.controller';
import { AdminVehicleMarketService } from './admin-vehicle-market.service';

@Module({
  controllers: [AdminMarketController, AdminCoinsController, AdminVipController, AdminVehicleMarketController],
  providers: [AdminMarketService, AdminCoinsService, AdminVipService, AdminVehicleMarketService],
  exports: [AdminMarketService],
})
export class AdminModule {}
