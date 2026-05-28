import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { JwtPayload } from '../auth/strategies/jwt.strategy';
import { PaginationQueryDto } from '../common/dto/pagination-query.dto';
import { UsersService } from '../users/users.service';
import { CodesService } from './codes.service';

@Controller('codes')
@UseGuards(JwtAuthGuard)
export class CodesController {
  constructor(private readonly codes: CodesService, private readonly users: UsersService) {}

  /** GET /codes — current user's redeem code history (with items). Paginated. */
  @Get()
  async list(@CurrentUser() user: JwtPayload, @Query() q: PaginationQueryDto) {
    const steamId = await this.users.findSteamByDiscord(user.sub);
    return this.codes.listMine(steamId, q.page, q.limit);
  }
}
