import {
  Body,
  Controller,
  ForbiddenException,
  Get,
  Param,
  ParseIntPipe,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { ArrayMaxSize, IsArray, IsIn, IsInt, IsOptional, IsPositive, Min } from 'class-validator';
import { Type } from 'class-transformer';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { JwtPayload } from '../auth/strategies/jwt.strategy';
import { UsersService } from '../users/users.service';
import { PurchasesService } from './purchases.service';
import { PurchaseFilter } from './purchases.types';

/** Max purchases claimable in one request — caps lock duration on sv_p2p_purchases. */
const CLAIM_ALL_MAX_IDS = 200;

class ListMineQuery {
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) page?: number;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) limit?: number;
  @IsOptional() @IsIn(['unclaimed', 'claimed', 'all']) status?: PurchaseFilter;
}

class ClaimAllDto {
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(CLAIM_ALL_MAX_IDS)
  @IsInt({ each: true })
  @IsPositive({ each: true })
  ids?: number[];
}

@Controller('purchases')
@UseGuards(JwtAuthGuard)
export class PurchasesController {
  constructor(
    private readonly svc: PurchasesService,
    private readonly users: UsersService,
  ) {}

  private async requireSteam(user: JwtPayload): Promise<string> {
    const steam = user.steam_id ?? (await this.users.findSteamByDiscord(user.sub));
    if (!steam) throw new ForbiddenException('Discord account not linked to Steam');
    return steam;
  }

  @Get('me')
  async listMine(@CurrentUser() user: JwtPayload, @Query() q: ListMineQuery) {
    const steam = await this.requireSteam(user);
    return this.svc.listMine(steam, q.status ?? 'unclaimed', q.page, q.limit);
  }

  /** Claim all unclaimed purchases (optionally a subset via `ids`) into one redeem code. */
  @Post('claim-all')
  async claimAll(@CurrentUser() user: JwtPayload, @Body() body: ClaimAllDto) {
    const steam = await this.requireSteam(user);
    return this.svc.claimAll(steam, body.ids);
  }

  @Post(':id(\\d+)/claim')
  async claim(@CurrentUser() user: JwtPayload, @Param('id', ParseIntPipe) id: number) {
    const steam = await this.requireSteam(user);
    return this.svc.claim(id, steam);
  }
}
