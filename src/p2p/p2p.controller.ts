import {
  Body,
  Controller,
  Delete,
  ForbiddenException,
  Get,
  Param,
  ParseIntPipe,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { IsInt, IsNumber, IsOptional, IsString, Min } from 'class-validator';
import { Type } from 'class-transformer';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { AdminGuard } from '../common/guards/admin.guard';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { JwtPayload } from '../auth/strategies/jwt.strategy';
import { PaginationQueryDto } from '../common/dto/pagination-query.dto';
import { UsersService } from '../users/users.service';
import { P2pService } from './p2p.service';

class CreateListingDto {
  @IsString() vault_name!: string;
  @IsInt() @Min(0) item_index!: number;
  @IsNumber() @Min(1) price!: number;
}

class ListingsQuery extends PaginationQueryDto {
  @IsOptional() @Type(() => Number) @IsInt() item_id?: number;
  @IsOptional() @Type(() => Number) @IsInt() type_id?: number;
  @IsOptional() @IsString() seller?: string;
  @IsOptional() @IsString() status?: 'active' | 'sold' | 'cancelled' | 'expired';
  @IsOptional() @Type(() => Number) @IsNumber() min_price?: number;
  @IsOptional() @Type(() => Number) @IsNumber() max_price?: number;
}

@Controller('p2p/listings')
@UseGuards(JwtAuthGuard)
export class P2pController {
  constructor(
    private readonly p2p: P2pService,
    private readonly users: UsersService,
  ) {}

  private async requireSteam(user: JwtPayload): Promise<string> {
    const steam = user.steam_id ?? (await this.users.findSteamByDiscord(user.sub));
    if (!steam) throw new ForbiddenException('Discord account not linked to Steam');
    return steam;
  }

  @Get()
  list(@Query() q: ListingsQuery) {
    return this.p2p.listActive({
      item_id: q.item_id, type_id: q.type_id, seller: q.seller,
      status: q.status, min_price: q.min_price, max_price: q.max_price,
      page: q.page, limit: q.limit,
    });
  }

  @Get('me')
  async listMine(@CurrentUser() user: JwtPayload, @Query() q: PaginationQueryDto) {
    const steam = await this.requireSteam(user);
    return this.p2p.listingsForSeller(steam, q.page, q.limit);
  }

  @Get(':id(\\d+)')
  getOne(@Param('id', ParseIntPipe) id: number) {
    return this.p2p.getListing(id);
  }

  @Post()
  async create(@CurrentUser() user: JwtPayload, @Body() body: CreateListingDto) {
    const steam = await this.requireSteam(user);
    return this.p2p.createListing(steam, {
      vaultName: body.vault_name,
      itemIndex: body.item_index,
      price: body.price,
    });
  }

  @Delete(':id(\\d+)')
  async cancel(@CurrentUser() user: JwtPayload, @Param('id', ParseIntPipe) id: number) {
    const steam = await this.requireSteam(user);
    return this.p2p.cancelListing(steam, id);
  }

  @Post(':id/buy')
  async buy(@CurrentUser() user: JwtPayload, @Param('id', ParseIntPipe) id: number) {
    const steam = await this.requireSteam(user);
    return this.p2p.buyListing(steam, id);
  }
}

@Controller('admin/p2p/listings')
@UseGuards(JwtAuthGuard, AdminGuard)
export class AdminP2pController {
  constructor(private readonly p2p: P2pService) {}

  @Post(':id/force-close')
  forceClose(@Param('id', ParseIntPipe) id: number, @CurrentUser() user: JwtPayload) {
    return this.p2p.adminForceClose(id, user.sub);
  }
}

/** Public UI hints for the web client (no auth). Commission is returned as a 0-1 fraction. */
@Controller('config/p2p')
export class P2pConfigController {
  constructor(private readonly cfg: ConfigService) {}

  @Get()
  get(): { commission: number; ttl_days: number } {
    const pct = Number(this.cfg.get<number>('p2p.commissionPercent') ?? 5);
    const ttl = Number(this.cfg.get<number>('p2p.ttlDays') ?? 7);
    return {
      commission: Math.min(1, Math.max(0, pct / 100)),
      ttl_days: ttl,
    };
  }
}
