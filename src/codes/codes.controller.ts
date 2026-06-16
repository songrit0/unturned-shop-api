import { ArrayMaxSize, ArrayMinSize, IsArray, IsInt, IsPositive } from 'class-validator';
import { Body, Controller, Get, Post, Query, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { JwtPayload } from '../auth/strategies/jwt.strategy';
import { PaginationQueryDto } from '../common/dto/pagination-query.dto';
import { UsersService } from '../users/users.service';
import { CodesService } from './codes.service';

class MergeCodesDto {
  @IsArray()
  @ArrayMinSize(2)
  @ArrayMaxSize(50)
  @IsInt({ each: true })
  @IsPositive({ each: true })
  ids!: number[];
}

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

  /** POST /codes/merge — merge selected available codes into one combined code. */
  @Post('merge')
  async merge(@CurrentUser() user: JwtPayload, @Body() body: MergeCodesDto) {
    const steamId = await this.users.findSteamByDiscord(user.sub);
    if (!steamId) throw new Error('steam_not_linked');
    return this.codes.merge(steamId, body.ids);
  }
}
