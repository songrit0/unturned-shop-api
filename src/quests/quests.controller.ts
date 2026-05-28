import {
  Body, Controller, Delete, ForbiddenException, Get, Param, ParseIntPipe,
  Post, Put, Query, UseGuards,
} from '@nestjs/common';
import {
  ArrayMinSize, IsArray, IsBoolean, IsIn, IsInt, IsOptional, IsString,
  MaxLength, Min, ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { AdminGuard } from '../common/guards/admin.guard';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { JwtPayload } from '../auth/strategies/jwt.strategy';
import { PaginationQueryDto } from '../common/dto/pagination-query.dto';
import { UsersService } from '../users/users.service';
import { QuestsService } from './quests.service';

class QuestItemDto {
  @IsInt() @Min(1) item_id!: number;
  @IsInt() @Min(1) qty_required!: number;
}

class UpsertQuestDto {
  @IsString() @MaxLength(128) name!: string;
  @IsOptional() @IsString() @MaxLength(512) description?: string;
  @IsInt() @Min(0) reward_coins!: number;
  @IsIn(['once', 'daily', 'weekly']) reset_type!: 'once' | 'daily' | 'weekly';
  @IsOptional() @IsBoolean() enabled?: boolean;
  @IsOptional() @IsString() start_at?: string;
  @IsOptional() @IsString() end_at?: string;
  @IsArray() @ArrayMinSize(1) @ValidateNested({ each: true }) @Type(() => QuestItemDto)
  items!: QuestItemDto[];
}

@Controller('admin/quests')
@UseGuards(JwtAuthGuard, AdminGuard)
export class AdminQuestsController {
  constructor(private readonly svc: QuestsService) {}

  @Get() list(@Query() q: PaginationQueryDto) { return this.svc.listAll(q.page, q.limit); }
  @Get(':id') getOne(@Param('id', ParseIntPipe) id: number) { return this.svc.getOne(id); }

  @Post()
  create(@Body() body: UpsertQuestDto) {
    return this.svc.create({
      name: body.name,
      description: body.description ?? null,
      reward_coins: body.reward_coins,
      reset_type: body.reset_type,
      enabled: body.enabled !== false,
      start_at: body.start_at ?? null,
      end_at: body.end_at ?? null,
      items: body.items,
    });
  }

  @Put(':id')
  update(@Param('id', ParseIntPipe) id: number, @Body() body: UpsertQuestDto) {
    return this.svc.update(id, {
      name: body.name,
      description: body.description ?? null,
      reward_coins: body.reward_coins,
      reset_type: body.reset_type,
      enabled: body.enabled !== false,
      start_at: body.start_at ?? null,
      end_at: body.end_at ?? null,
      items: body.items,
    });
  }

  @Delete(':id') remove(@Param('id', ParseIntPipe) id: number) { return this.svc.remove(id); }
}

@Controller('quests')
@UseGuards(JwtAuthGuard)
export class QuestsController {
  constructor(private readonly svc: QuestsService, private readonly users: UsersService) {}

  @Get()
  async list(@CurrentUser() user: JwtPayload) {
    const steamId = await this.users.findSteamByDiscord(user.sub);
    if (!steamId) throw new ForbiddenException('Steam account not linked');
    return this.svc.listActiveForPlayer(steamId);
  }

  @Get('history')
  async history(@CurrentUser() user: JwtPayload, @Query() q: PaginationQueryDto) {
    const steamId = await this.users.findSteamByDiscord(user.sub);
    if (!steamId) throw new ForbiddenException('Steam account not linked');
    return this.svc.history(steamId, q.page, q.limit);
  }

  @Get(':id')
  async getOne(@CurrentUser() user: JwtPayload, @Param('id', ParseIntPipe) id: number) {
    const steamId = await this.users.findSteamByDiscord(user.sub);
    if (!steamId) throw new ForbiddenException('Steam account not linked');
    return this.svc.getOneForPlayer(id, steamId);
  }
}
