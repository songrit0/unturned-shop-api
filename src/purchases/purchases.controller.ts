import {
  Controller,
  ForbiddenException,
  Get,
  Param,
  ParseIntPipe,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { IsIn, IsInt, IsOptional, Min } from 'class-validator';
import { Type } from 'class-transformer';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { JwtPayload } from '../auth/strategies/jwt.strategy';
import { UsersService } from '../users/users.service';
import { PurchasesService } from './purchases.service';
import { PurchaseFilter } from './purchases.types';

class ListMineQuery {
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) page?: number;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) limit?: number;
  @IsOptional() @IsIn(['unclaimed', 'claimed', 'all']) status?: PurchaseFilter;
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

  @Post(':id(\\d+)/claim')
  async claim(@CurrentUser() user: JwtPayload, @Param('id', ParseIntPipe) id: number) {
    const steam = await this.requireSteam(user);
    return this.svc.claim(id, steam);
  }
}
