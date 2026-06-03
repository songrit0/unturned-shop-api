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
import { IsInt, IsNumber, IsOptional, IsString, Min } from 'class-validator';
import { Type } from 'class-transformer';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { AdminGuard } from '../common/guards/admin.guard';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { JwtPayload } from '../auth/strategies/jwt.strategy';
import { PaginationQueryDto } from '../common/dto/pagination-query.dto';
import { UsersService } from '../users/users.service';
import { P2pGarageService } from './p2p-garage.service';

class CreateGarageListingDto {
  @IsInt() @Min(1) garage_id!: number;
  @IsNumber() @Min(1) price!: number;
}

class GarageListingsQuery extends PaginationQueryDto {
  @IsOptional() @IsString() status?: 'active' | 'sold' | 'cancelled';
  @IsOptional() @IsString() seller?: string;
}

@Controller('p2p/garage')
@UseGuards(JwtAuthGuard)
export class P2pGarageController {
  constructor(
    private readonly garage: P2pGarageService,
    private readonly users: UsersService,
  ) {}

  private async requireSteam(user: JwtPayload): Promise<string> {
    const steam = user.steam_id ?? (await this.users.findSteamByDiscord(user.sub));
    if (!steam) throw new ForbiddenException('Discord account not linked to Steam');
    return steam;
  }

  @Get('mine-vehicles')
  async mineVehicles(@CurrentUser() user: JwtPayload) {
    const steam = await this.requireSteam(user);
    return this.garage.mineVehicles(steam);
  }

  @Get()
  list(@Query() q: GarageListingsQuery) {
    return this.garage.listActive({
      status: q.status, seller: q.seller, page: q.page, limit: q.limit,
    });
  }

  @Get('me')
  async listMine(@CurrentUser() user: JwtPayload, @Query() q: PaginationQueryDto) {
    const steam = await this.requireSteam(user);
    return this.garage.listingsForSeller(steam, q.page, q.limit);
  }

  @Get(':id(\\d+)')
  getOne(@Param('id', ParseIntPipe) id: number) {
    return this.garage.getListing(id);
  }

  @Post()
  async create(@CurrentUser() user: JwtPayload, @Body() body: CreateGarageListingDto) {
    const steam = await this.requireSteam(user);
    return this.garage.createListing(steam, { garageId: body.garage_id, price: body.price });
  }

  @Delete(':id(\\d+)')
  async cancel(@CurrentUser() user: JwtPayload, @Param('id', ParseIntPipe) id: number) {
    const steam = await this.requireSteam(user);
    return this.garage.cancelListing(steam, id);
  }

  @Post(':id/buy')
  async buy(@CurrentUser() user: JwtPayload, @Param('id', ParseIntPipe) id: number) {
    const steam = await this.requireSteam(user);
    return this.garage.buyListing(steam, id);
  }
}

@Controller('admin/p2p/garage')
@UseGuards(JwtAuthGuard, AdminGuard)
export class AdminP2pGarageController {
  constructor(private readonly garage: P2pGarageService) {}

  @Post(':id/force-close')
  forceClose(@Param('id', ParseIntPipe) id: number) {
    return this.garage.adminForceClose(id);
  }
}
