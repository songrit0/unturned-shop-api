import { Body, Controller, Delete, Get, Param, ParseIntPipe, Post, Put, Query, UseGuards } from '@nestjs/common';
import { IsBoolean, IsInt, IsNumber, IsOptional, Min } from 'class-validator';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { AdminGuard } from '../common/guards/admin.guard';
import { PaginationQueryDto } from '../common/dto/pagination-query.dto';
import { AdminVehicleMarketService } from './admin-vehicle-market.service';

class UpsertVehicleMarketDto {
  @IsInt() @Min(1) vehicle_id!: number;
  @IsNumber() @Min(0) price!: number;
  @IsInt() @Min(0) amount!: number;
  @IsOptional() @IsBoolean() enabled?: boolean;  // shop sells it
  // Meowcoin price; null/omitted clears it (not buyable with Meowcoin).
  @IsOptional() @IsInt() @Min(0) meowcoin_price?: number | null;
}

class ToggleDto { @IsBoolean() enabled!: boolean; }

@Controller('admin/vehicle-market')
@UseGuards(JwtAuthGuard, AdminGuard)
export class AdminVehicleMarketController {
  constructor(private readonly svc: AdminVehicleMarketService) {}

  @Get() list(@Query() q: PaginationQueryDto) { return this.svc.listAll(q.page, q.limit); }

  @Get(':id') getOne(@Param('id', ParseIntPipe) id: number) { return this.svc.getOne(id); }

  @Post()
  upsert(@Body() body: UpsertVehicleMarketDto) {
    return this.svc.upsert({
      vehicle_id: body.vehicle_id,
      price: body.price,
      amount: body.amount,
      enabled: body.enabled !== false,
      meowcoinPrice: body.meowcoin_price ?? null,
    });
  }

  @Put(':id/enabled')
  toggle(@Param('id', ParseIntPipe) id: number, @Body() body: ToggleDto) {
    return this.svc.toggleEnabled(id, body.enabled);
  }

  @Delete(':id') remove(@Param('id', ParseIntPipe) id: number) { return this.svc.remove(id); }
}
