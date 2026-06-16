import { Body, Controller, Get, Param, Post, UseGuards } from '@nestjs/common';
import { IsInt, Min } from 'class-validator';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { JwtPayload } from '../auth/strategies/jwt.strategy';
import { UsersService } from '../users/users.service';
import { XpService } from './xp.service';

class ConvertDto {
  @IsInt() @Min(1) amount!: number;
}

@Controller('xp')
@UseGuards(JwtAuthGuard)
export class XpController {
  constructor(private readonly xp: XpService, private readonly users: UsersService) {}

  /** Resolve the caller's steam_id (steam_pin login carries it directly; Discord login resolves via link). */
  private async resolveSteam(user: JwtPayload): Promise<string | null> {
    return user.steam_id ?? (await this.users.findSteamByDiscord(user.sub));
  }

  /** Current XP + online flag (from the plugin's mirror) + the rate/fee/min + a payout preview. */
  @Get('me')
  async me(@CurrentUser() user: JwtPayload) {
    return this.xp.me(await this.resolveSteam(user));
  }

  @Get('config')
  config() {
    return this.xp.config();
  }

  /** Queue an XP->coins conversion (online-only; the plugin executes it in-game). */
  @Post('convert')
  async convert(@CurrentUser() user: JwtPayload, @Body() body: ConvertDto) {
    return this.xp.convert(await this.resolveSteam(user), body.amount);
  }

  /** Poll a queued request's status (done -> coins_granted is filled). */
  @Get('request/:id')
  async status(@CurrentUser() user: JwtPayload, @Param('id') id: string) {
    return this.xp.requestStatus(await this.resolveSteam(user), parseInt(id, 10));
  }
}
