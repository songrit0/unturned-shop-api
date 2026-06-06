import {
  Body, Controller, Delete, Get, Param, ParseIntPipe, Post, Put, UseGuards,
} from '@nestjs/common';
import {
  IsBoolean, IsIn, IsInt, IsObject, IsOptional, IsString, Max, MaxLength, Min,
} from 'class-validator';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { AdminGuard } from '../common/guards/admin.guard';
import { GachaService } from './gacha.service';
import { GachaPrizeType } from './gacha.types';

class PrizeDto {
  @IsIn(['coins', 'meowcoins', 'item', 'vehicle', 'vip']) type!: GachaPrizeType;
  @IsOptional() @IsInt() ref_id?: number | null;
  @IsInt() @Min(0) amount!: number;
  @IsOptional() @IsInt() @Min(0) @Max(100) quality?: number;
  @IsOptional() @IsInt() @Min(0) weight?: number;
  @IsOptional() @IsString() @MaxLength(128) label?: string | null;
  @IsOptional() @IsString() @MaxLength(512) image_url?: string | null;
  @IsOptional() @IsString() @MaxLength(16) rarity?: string | null;
  @IsOptional() @IsBoolean() enabled?: boolean;
  @IsOptional() @IsInt() sort?: number;
}

class ConfigDto {
  @IsOptional() @IsBoolean() enabled?: boolean;
  @IsOptional() @IsInt() @Min(0) @Max(100) base_free_spins?: number;
  @IsOptional() @IsObject() rank_bonus?: Record<string, number>;
  @IsOptional() @IsInt() @Min(0) price_coins?: number | null;
  @IsOptional() @IsInt() @Min(0) price_meowcoins?: number | null;
  @IsOptional() @IsInt() @Min(1) @Max(365) code_ttl_days?: number;
}

/** Admin: configure the gacha prize pool + rules. */
@Controller('admin/gacha')
@UseGuards(JwtAuthGuard, AdminGuard)
export class AdminGachaController {
  constructor(private readonly service: GachaService) {}

  @Get('prizes')
  prizes() {
    return this.service.listPrizes();
  }

  @Post('prizes')
  create(@Body() body: PrizeDto) {
    return this.service.createPrize(body);
  }

  @Put('prizes/:id')
  update(@Param('id', ParseIntPipe) id: number, @Body() body: PrizeDto) {
    return this.service.updatePrize(id, body);
  }

  @Delete('prizes/:id')
  async remove(@Param('id', ParseIntPipe) id: number) {
    await this.service.deletePrize(id);
    return { ok: true };
  }

  @Get('config')
  getConfig() {
    return this.service.getConfig();
  }

  @Put('config')
  setConfig(@Body() body: ConfigDto) {
    return this.service.updateConfig(body);
  }
}
