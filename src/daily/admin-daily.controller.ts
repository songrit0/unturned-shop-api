import {
  Body, Controller, Delete, Get, Param, ParseIntPipe, Post, Put, UseGuards,
} from '@nestjs/common';
import {
  IsBoolean, IsIn, IsInt, IsOptional, Max, Min,
} from 'class-validator';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { AdminGuard } from '../common/guards/admin.guard';
import { DailyService } from './daily.service';
import { DailyKind, DailyTier } from './daily.types';

class TierConfigDto {
  @IsOptional() @IsBoolean() enabled?: boolean;
  @IsOptional() @IsInt() @Min(0) coins?: number;
  @IsOptional() @IsInt() @Min(1) @Max(365) codeTtlDays?: number;
}

class CreateItemDto {
  @IsIn(['normal', 'vip']) tier!: DailyTier;
  @IsInt() @Min(1) itemId!: number;
  @IsInt() @Min(1) amount!: number;
  @IsOptional() @IsInt() @Min(0) @Max(100) quality?: number;
  @IsOptional() @IsIn([0, 1]) kind?: DailyKind;
  @IsOptional() @IsInt() sort?: number;
  @IsOptional() @IsBoolean() enabled?: boolean;
}

class UpdateItemDto {
  @IsOptional() @IsIn(['normal', 'vip']) tier?: DailyTier;
  @IsOptional() @IsInt() @Min(1) itemId?: number;
  @IsOptional() @IsInt() @Min(1) amount?: number;
  @IsOptional() @IsInt() @Min(0) @Max(100) quality?: number;
  @IsOptional() @IsIn([0, 1]) kind?: DailyKind;
  @IsOptional() @IsInt() sort?: number;
  @IsOptional() @IsBoolean() enabled?: boolean;
}

/** Admin: configure the daily-reward tiers + their item/vehicle bundles. */
@Controller('admin/daily')
@UseGuards(JwtAuthGuard, AdminGuard)
export class AdminDailyController {
  constructor(private readonly service: DailyService) {}

  @Get('config')
  getConfig() {
    return this.service.getAdminConfig();
  }

  @Put('config/:tier')
  updateTier(@Param('tier') tier: DailyTier, @Body() body: TierConfigDto) {
    return this.service.updateTierConfig(tier, body);
  }

  @Post('items')
  createItem(@Body() body: CreateItemDto) {
    return this.service.createItem(body);
  }

  @Put('items/:id')
  updateItem(@Param('id', ParseIntPipe) id: number, @Body() body: UpdateItemDto) {
    return this.service.updateItem(id, body);
  }

  @Delete('items/:id')
  async deleteItem(@Param('id', ParseIntPipe) id: number) {
    await this.service.deleteItem(id);
    return { ok: true };
  }
}
