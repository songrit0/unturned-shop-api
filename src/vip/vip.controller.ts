import { BadRequestException, Body, Controller, Get, Post, UseGuards } from '@nestjs/common';
import { IsIn, IsInt, IsOptional } from 'class-validator';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { JwtPayload } from '../auth/strategies/jwt.strategy';
import { UsersService } from '../users/users.service';
import { VipService, VipCurrency } from './vip.service';

class BuyDto {
  @IsInt() package_id!: number;
  @IsOptional() @IsIn(['coin', 'meowcoin']) currency?: VipCurrency;
}

@Controller('vip')
@UseGuards(JwtAuthGuard)
export class VipController {
  constructor(private readonly vip: VipService, private readonly users: UsersService) {}

  /** Enabled VIP packages available to buy. */
  @Get('packages')
  packages() {
    return this.vip.listEnabled();
  }

  /** The current user's active VIP grants + their resolved steam id. */
  @Get('mine')
  async mine(@CurrentUser() user: JwtPayload) {
    const steam = user.steam_id ?? (await this.users.findSteamByDiscord(user.sub));
    if (!steam) return { linked: false, steam_id: null, grants: [] };
    return { linked: true, steam_id: steam, grants: await this.vip.grantsForSteam(steam) };
  }

  /** Buy a VIP package with Coin (default) or Meowcoin. */
  @Post('buy')
  async buy(@CurrentUser() user: JwtPayload, @Body() body: BuyDto) {
    const steam = user.steam_id ?? (await this.users.findSteamByDiscord(user.sub));
    if (!steam) throw new BadRequestException('ยังไม่ได้เชื่อมบัญชี — ผูก Discord ↔ Steam ก่อน');
    return this.vip.buy(steam, body.package_id, body.currency ?? 'coin');
  }
}
