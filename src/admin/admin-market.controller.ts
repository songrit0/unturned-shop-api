import { Body, Controller, Delete, Get, Param, ParseIntPipe, Post, Put, UseGuards } from '@nestjs/common';
import { IsBoolean, IsInt, IsNumber, IsOptional, Max, Min } from 'class-validator';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { AdminGuard } from '../common/guards/admin.guard';
import { AdminMarketService } from './admin-market.service';

class UpsertMarketDto {
  @IsInt() @Min(1) item_id!: number;
  @IsNumber() @Min(0) base_price!: number;
  @IsInt() @Min(1) target_stock!: number;
  @IsNumber() @Min(0) @Max(2) elasticity!: number;
  @IsInt() @Min(0) amount!: number;
  @IsOptional() @IsBoolean() enabled?: boolean;
}

class ToggleDto { @IsBoolean() enabled!: boolean; }

@Controller('admin/market')
@UseGuards(JwtAuthGuard, AdminGuard)
export class AdminMarketController {
  constructor(private readonly svc: AdminMarketService) {}

  @Get() list() { return this.svc.listAll(); }
  @Get(':id') getOne(@Param('id', ParseIntPipe) id: number) { return this.svc.getOne(id); }

  @Post()
  upsert(@Body() body: UpsertMarketDto) {
    return this.svc.upsert({
      item_id: body.item_id,
      base_price: body.base_price, target_stock: body.target_stock, elasticity: body.elasticity,
      amount: body.amount,
      enabled: body.enabled !== false,
    });
  }

  @Put(':id/enabled')
  toggle(@Param('id', ParseIntPipe) id: number, @Body() body: ToggleDto) {
    return this.svc.toggleEnabled(id, body.enabled);
  }

  @Delete(':id') remove(@Param('id', ParseIntPipe) id: number) { return this.svc.remove(id); }
}
