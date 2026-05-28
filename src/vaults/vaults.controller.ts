import {
  BadRequestException,
  Body,
  Controller,
  ForbiddenException,
  Get,
  Param,
  Put,
  Query,
  UseGuards,
} from '@nestjs/common';
import { ArrayMaxSize, IsArray, IsInt, IsOptional, IsString, Max, Min, ValidateNested } from 'class-validator';
import { Type } from 'class-transformer';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { AdminGuard } from '../common/guards/admin.guard';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { JwtPayload } from '../auth/strategies/jwt.strategy';
import { PaginationQueryDto } from '../common/dto/pagination-query.dto';
import { UsersService } from '../users/users.service';
import { VaultsService } from './vaults.service';

class VaultItemDto {
  @IsInt() @Min(0) X!: number;
  @IsInt() @Min(0) Y!: number;
  @IsInt() @Min(0) @Max(3) Rot!: number;
  @IsInt() @Min(1) Amount!: number;
  @IsInt() @Min(0) @Max(100) Quality!: number;
  @IsString() State!: string;
  @IsInt() @Min(1) Id!: number;
}

class UpdateVaultDto {
  @IsArray()
  @ArrayMaxSize(1024)
  @ValidateNested({ each: true })
  @Type(() => VaultItemDto)
  items!: VaultItemDto[];
}

class AdminVaultListQuery extends PaginationQueryDto {
  @IsOptional() @IsString() steam_id?: string;
  @IsOptional() @IsString() name?: string;
  @IsOptional() @IsString() discord_id?: string;
  @IsOptional() @IsString() q?: string;
}

@Controller('vaults')
@UseGuards(JwtAuthGuard)
export class VaultsController {
  constructor(
    private readonly vaults: VaultsService,
    private readonly users: UsersService,
  ) {}

  private async requireSteam(user: JwtPayload): Promise<string> {
    const steam = user.steam_id ?? (await this.users.findSteamByDiscord(user.sub));
    if (!steam) throw new ForbiddenException('Discord account not linked to Steam');
    return steam;
  }

  @Get('me')
  async listMine(@CurrentUser() user: JwtPayload) {
    const steam = await this.requireSteam(user);
    return this.vaults.findByOwner(steam);
  }

  @Get('me/:name')
  async getMine(@CurrentUser() user: JwtPayload, @Param('name') name: string) {
    const steam = await this.requireSteam(user);
    return this.vaults.getVault(steam, name);
  }

  @Put('me/:name')
  async updateMine(
    @CurrentUser() user: JwtPayload,
    @Param('name') name: string,
    @Body() body: UpdateVaultDto,
  ) {
    if (!body || !Array.isArray(body.items)) throw new BadRequestException('items required');
    const steam = await this.requireSteam(user);
    return this.vaults.updateVault(steam, name, body.items);
  }
}

@Controller('vaults')
@UseGuards(JwtAuthGuard, AdminGuard)
export class AdminVaultsController {
  constructor(private readonly vaults: VaultsService) {}

  @Get()
  list(@Query() q: AdminVaultListQuery) {
    return this.vaults.listAll({
      steamId: q.steam_id,
      name: q.name,
      discordId: q.discord_id,
      q: q.q,
      page: q.page,
      limit: q.limit,
    });
  }

  @Get(':steamId/:name')
  getOne(@Param('steamId') steamId: string, @Param('name') name: string) {
    return this.vaults.getVault(steamId, name);
  }

  @Put(':steamId/:name')
  update(
    @Param('steamId') steamId: string,
    @Param('name') name: string,
    @Body() body: UpdateVaultDto,
  ) {
    if (!body || !Array.isArray(body.items)) throw new BadRequestException('items required');
    return this.vaults.updateVault(steamId, name, body.items);
  }
}
