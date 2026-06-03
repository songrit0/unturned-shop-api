import { Module } from '@nestjs/common';
import { VehiclesService } from './vehicles.service';
import { VehicleMarketService } from './vehicle-market.service';
import {
  AdminVehiclesController,
  VehiclesController,
  VehicleMarketController,
} from './vehicles.controller';

@Module({
  controllers: [AdminVehiclesController, VehiclesController, VehicleMarketController],
  providers: [VehiclesService, VehicleMarketService],
  exports: [VehiclesService, VehicleMarketService],
})
export class VehiclesModule {}
