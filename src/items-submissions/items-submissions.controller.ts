import {
  BadRequestException,
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
import { IsIn, IsInt, IsOptional, IsString, MaxLength, Min } from 'class-validator';
import { Type } from 'class-transformer';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { AdminGuard } from '../common/guards/admin.guard';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { JwtPayload } from '../auth/strategies/jwt.strategy';
import { PaginationQueryDto } from '../common/dto/pagination-query.dto';
import { UsersService } from '../users/users.service';
import { ItemsSubmissionsService } from './items-submissions.service';

class CreateSubmissionDto {
  @IsOptional() @IsString() @MaxLength(128) name?: string;
  @IsOptional() @IsString() @MaxLength(2048) description?: string;
  @IsOptional() @IsString() @MaxLength(2048) image_url?: string;
  @IsOptional() @Type(() => Number) @IsInt() type_id?: number;
}

class RejectSubmissionDto {
  @IsOptional() @IsString() @MaxLength(2048) admin_note?: string;
}

class AdminListQuery {
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) page?: number;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) limit?: number;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) item_id?: number;
  @IsOptional() @IsIn(['pending', 'approved', 'rejected']) status?: 'pending' | 'approved' | 'rejected';
}

@Controller()
@UseGuards(JwtAuthGuard)
export class ItemsSubmissionsController {
  constructor(
    private readonly svc: ItemsSubmissionsService,
    private readonly users: UsersService,
  ) {}

  private async requireSteam(user: JwtPayload): Promise<string> {
    const steam = user.steam_id ?? (await this.users.findSteamByDiscord(user.sub));
    if (!steam) throw new ForbiddenException('Discord account not linked to Steam');
    return steam;
  }

  @Post('items/:id/submissions')
  async create(
    @CurrentUser() user: JwtPayload,
    @Param('id', ParseIntPipe) id: number,
    @Body() body: CreateSubmissionDto,
  ) {
    if (!body) throw new BadRequestException('body required');
    const steam = await this.requireSteam(user);
    return this.svc.create(id, steam, {
      name: body.name ?? null,
      description: body.description ?? null,
      image_url: body.image_url ?? null,
      type_id: body.type_id ?? null,
    });
  }

  @Get('items/submissions/me')
  async listMine(@CurrentUser() user: JwtPayload, @Query() q: PaginationQueryDto) {
    const steam = await this.requireSteam(user);
    return this.svc.listMine(steam, q.page, q.limit);
  }
}

@Controller('admin/items/submissions')
@UseGuards(JwtAuthGuard, AdminGuard)
export class AdminItemsSubmissionsController {
  constructor(
    private readonly svc: ItemsSubmissionsService,
    private readonly users: UsersService,
  ) {}

  private async requireAdminSteam(user: JwtPayload): Promise<string> {
    const steam = user.steam_id ?? (await this.users.findSteamByDiscord(user.sub));
    if (!steam) throw new ForbiddenException('Admin Discord account not linked to Steam');
    return steam;
  }

  @Get()
  list(@Query() q: AdminListQuery) {
    return this.svc.listAdmin({
      status: q.status,
      item_id: q.item_id,
      page: q.page,
      limit: q.limit,
    });
  }

  @Post(':id/approve')
  async approve(@CurrentUser() user: JwtPayload, @Param('id', ParseIntPipe) id: number) {
    const steam = await this.requireAdminSteam(user);
    return this.svc.approve(id, steam);
  }

  @Post(':id/reject')
  async reject(
    @CurrentUser() user: JwtPayload,
    @Param('id', ParseIntPipe) id: number,
    @Body() body: RejectSubmissionDto,
  ) {
    const steam = await this.requireAdminSteam(user);
    return this.svc.reject(id, steam, body?.admin_note ?? null);
  }
}
