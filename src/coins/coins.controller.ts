import { BadRequestException, Body, Controller, Get, Post, Query, UseGuards } from '@nestjs/common';
import { IsIn, IsInt, IsString } from 'class-validator';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { JwtPayload } from '../auth/strategies/jwt.strategy';
import { UsersService } from '../users/users.service';
import { CoinsService } from './coins.service';

class TransferLookupDto {
  @IsIn(['steam', 'discord']) target_type!: 'steam' | 'discord';
  @IsString() target_id!: string;
}

class TransferDto {
  @IsIn(['steam', 'discord']) target_type!: 'steam' | 'discord';
  @IsString() target_id!: string;
  @IsInt() amount!: number;
}

@Controller('coins')
@UseGuards(JwtAuthGuard)
export class CoinsController {
  constructor(private readonly coins: CoinsService, private readonly users: UsersService) {}

  /** Resolve the caller's steam_id (steam_pin login carries it directly; Discord login resolves via link). */
  private async resolveSteam(user: JwtPayload): Promise<string | null> {
    return user.steam_id ?? (await this.users.findSteamByDiscord(user.sub));
  }

  @Get('me')
  async me(@CurrentUser() user: JwtPayload) {
    const steamId = await this.users.findSteamByDiscord(user.sub);
    const balance = await this.coins.getBalance(steamId);
    return { steam_id: steamId, linked: !!steamId, balance };
  }

  @Get('config')
  config() {
    return this.coins.transferConfig();
  }

  @Get('stats')
  async stats(@CurrentUser() user: JwtPayload) {
    const steamId = await this.users.findSteamByDiscord(user.sub);
    return this.coins.stats(steamId, 7);
  }

  @Get('history/market')
  async marketHistory(
    @CurrentUser() user: JwtPayload,
    @Query('page') page?: string,
    @Query('limit') limit?: string,
  ) {
    const steamId = await this.users.findSteamByDiscord(user.sub);
    return this.coins.marketHistory(steamId, parseInt(page!, 10), parseInt(limit!, 10));
  }

  @Get('history/activity')
  async activityHistory(
    @CurrentUser() user: JwtPayload,
    @Query('page') page?: string,
    @Query('limit') limit?: string,
  ) {
    const steamId = await this.users.findSteamByDiscord(user.sub);
    return this.coins.activityHistory(steamId, parseInt(page!, 10), parseInt(limit!, 10));
  }

  /** Unified Coin transaction-history timeline (shop + p2p + admin/tax + transfers), newest first. */
  @Get('history/all')
  async unifiedHistory(
    @CurrentUser() user: JwtPayload,
    @Query('page') page?: string,
    @Query('limit') limit?: string,
  ) {
    const steamId = await this.resolveSteam(user);
    return this.coins.unifiedHistory(steamId, parseInt(page!, 10), parseInt(limit!, 10));
  }

  /** Resolve a transfer recipient by Steam ID or Discord ID. */
  @Post('transfer/lookup')
  async transferLookup(@CurrentUser() user: JwtPayload, @Body() body: TransferLookupDto) {
    const steamId = await this.resolveSteam(user);
    return this.coins.lookupRecipient(body.target_type, body.target_id, steamId);
  }

  /** Transfer Coins to another player. Sender pays amount + flat fee; recipient receives the full amount. */
  @Post('transfer')
  async transfer(@CurrentUser() user: JwtPayload, @Body() body: TransferDto) {
    const steamId = await this.resolveSteam(user);
    if (!steamId) throw new BadRequestException('target_not_found');
    return this.coins.transfer(steamId, body.target_type, body.target_id, body.amount);
  }
}
