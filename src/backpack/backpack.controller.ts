import { BadRequestException, Body, Controller, Get, Post, UseGuards } from '@nestjs/common';
import { IsIn } from 'class-validator';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { JwtPayload } from '../auth/strategies/jwt.strategy';
import { UsersService } from '../users/users.service';
import { BackpackService, BackpackPayMethod } from './backpack.service';

class UpgradeDto {
  @IsIn(['coins', 'meowcoins', 'mixed']) method!: BackpackPayMethod;
}

@Controller('backpack')
@UseGuards(JwtAuthGuard)
export class BackpackController {
  constructor(
    private readonly backpack: BackpackService,
    private readonly users: UsersService,
  ) {}

  private async steamOf(user: JwtPayload): Promise<string> {
    const steam = user.steam_id ?? (await this.users.findSteamByDiscord(user.sub));
    if (!steam) throw new BadRequestException('ยังไม่ได้เชื่อมบัญชี — ผูก Discord ↔ Steam ก่อน');
    return steam;
  }

  /** Current backpack size/level + next-upgrade costs for the caller. */
  @Get('me')
  async me(@CurrentUser() user: JwtPayload) {
    return this.backpack.me(await this.steamOf(user));
  }

  /** Upgrade one level, paying with coins, meowcoins, or mixed (half each). */
  @Post('upgrade')
  async upgrade(@CurrentUser() user: JwtPayload, @Body() body: UpgradeDto) {
    return this.backpack.upgrade(await this.steamOf(user), body.method);
  }
}
