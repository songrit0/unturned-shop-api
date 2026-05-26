import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { JwtPayload } from '../auth/strategies/jwt.strategy';
import { UsersService } from '../users/users.service';
import { CodesService } from './codes.service';

@Controller('codes')
@UseGuards(JwtAuthGuard)
export class CodesController {
  constructor(private readonly codes: CodesService, private readonly users: UsersService) {}

  /** GET /codes — current user's redeem code history (with items). */
  @Get()
  async list(@CurrentUser() user: JwtPayload, @Query('limit') limit?: string) {
    const steamId = await this.users.findSteamByDiscord(user.sub);
    const n = Math.min(Math.max(parseInt(limit || '50', 10) || 50, 1), 200);
    return this.codes.listMine(steamId, n);
  }
}
