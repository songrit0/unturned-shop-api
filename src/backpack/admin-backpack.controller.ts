import {
  Body, Controller, Get, Param, Patch, Query, UseGuards,
} from '@nestjs/common';
import { IsBoolean, IsInt, IsOptional, Min } from 'class-validator';
import { Type } from 'class-transformer';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { AdminGuard } from '../common/guards/admin.guard';
import { BackpackService } from './backpack.service';

class ConfigDto {
  @IsOptional() @IsBoolean() enabled?: boolean;
  @IsOptional() @IsBoolean() vip_only?: boolean;
  @IsOptional() @Type(() => Number) @IsInt() @Min(0) base_coins?: number;
  @IsOptional() @Type(() => Number) @IsInt() @Min(0) base_meowcoins?: number;
  @IsOptional() @IsBoolean() mixed_enabled?: boolean;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) default_height?: number;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) max_height?: number;
}

class SizeDto {
  @Type(() => Number) @IsInt() @Min(1) width!: number;
  @Type(() => Number) @IsInt() @Min(1) height!: number;
}

@Controller('admin/backpack')
@UseGuards(JwtAuthGuard, AdminGuard)
export class AdminBackpackController {
  constructor(private readonly backpack: BackpackService) {}

  @Get('config')
  getConfig() {
    return this.backpack.getConfig();
  }

  @Patch('config')
  updateConfig(@Body() body: ConfigDto) {
    return this.backpack.updateConfig(body);
  }

  @Get('players')
  players(
    @Query('search') search?: string,
    @Query('page') page?: string,
    @Query('limit') limit?: string,
  ) {
    return this.backpack.listPlayers(search?.trim() || undefined, Number(page) || 1, Number(limit) || 20);
  }

  @Patch('players/:steamId')
  setSize(@Param('steamId') steamId: string, @Body() body: SizeDto) {
    return this.backpack.setPlayerSize(steamId, body.width, body.height);
  }
}
