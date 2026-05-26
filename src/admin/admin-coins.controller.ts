import { Body, Controller, Get, Param, Post, Query, UseGuards } from '@nestjs/common';
import { IsInt, IsOptional, IsString, MaxLength } from 'class-validator';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { AdminGuard } from '../common/guards/admin.guard';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { JwtPayload } from '../auth/strategies/jwt.strategy';
import { AdminCoinsService } from './admin-coins.service';

class AdjustDto {
  @IsInt() delta!: number;
  @IsOptional() @IsString() @MaxLength(80) reason?: string;
}

@Controller('admin/coins')
@UseGuards(JwtAuthGuard, AdminGuard)
export class AdminCoinsController {
  constructor(private readonly svc: AdminCoinsService) {}

  @Get('users')
  list(
    @Query('page') page?: string,
    @Query('limit') limit?: string,
    @Query('q') q?: string,
  ) {
    return this.svc.listUsers(parseInt(page!, 10), parseInt(limit!, 10), q || '');
  }

  @Get(':steamId')
  getOne(@Param('steamId') steamId: string) {
    return this.svc.getOne(steamId);
  }

  @Get(':steamId/history')
  history(@Param('steamId') steamId: string, @Query('limit') limit?: string) {
    return this.svc.historyForUser(steamId, parseInt(limit!, 10) || 30);
  }

  @Post(':steamId/adjust')
  adjust(
    @CurrentUser() admin: JwtPayload,
    @Param('steamId') steamId: string,
    @Body() body: AdjustDto,
  ) {
    return this.svc.adjust(steamId, body.delta, admin.sub, body.reason || '');
  }
}
