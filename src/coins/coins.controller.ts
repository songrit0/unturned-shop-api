import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { JwtPayload } from '../auth/strategies/jwt.strategy';
import { UsersService } from '../users/users.service';
import { CoinsService } from './coins.service';

@Controller('coins')
@UseGuards(JwtAuthGuard)
export class CoinsController {
  constructor(private readonly coins: CoinsService, private readonly users: UsersService) {}

  @Get('me')
  async me(@CurrentUser() user: JwtPayload) {
    const steamId = await this.users.findSteamByDiscord(user.sub);
    const balance = await this.coins.getBalance(steamId);
    return { steam_id: steamId, linked: !!steamId, balance };
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
}
