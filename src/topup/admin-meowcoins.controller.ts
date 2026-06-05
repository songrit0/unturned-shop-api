import { Body, Controller, Get, Param, Post, Query, UseGuards } from '@nestjs/common';
import { IsBoolean, IsInt, IsOptional, IsString, MaxLength } from 'class-validator';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { AdminGuard } from '../common/guards/admin.guard';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { JwtPayload } from '../auth/strategies/jwt.strategy';
import { AdminMeowcoinsService } from './admin-meowcoins.service';

class AdjustMeowcoinsDto {
  @IsString() steam_id!: string;
  @IsInt() delta!: number;
  @IsOptional() @IsString() @MaxLength(80) reason?: string;
}

class SetMeowcoinsDto {
  @IsString() steam_id!: string;
  @IsInt() balance!: number;
  @IsOptional() @IsString() @MaxLength(80) reason?: string;
}

class SetProviderDto {
  @IsString() @MaxLength(16) key!: string;
  @IsBoolean() enabled!: boolean;
}

/** Short actor id for the audit log: steam_id if present, else the Discord sub, else 'admin'. */
function actorOf(admin: JwtPayload): string {
  return (admin.steam_id ?? admin.sub ?? 'admin').toString().slice(0, 64);
}

@Controller('admin/meowcoins')
@UseGuards(JwtAuthGuard, AdminGuard)
export class AdminMeowcoinsController {
  constructor(private readonly svc: AdminMeowcoinsService) {}

  @Get('topups')
  topups(
    @Query('status') status?: string,
    @Query('q') q?: string,
    @Query('page') page?: string,
    @Query('limit') limit?: string,
  ) {
    return this.svc.listTopups(
      status,
      q,
      page != null ? parseInt(page, 10) : undefined,
      limit != null ? parseInt(limit, 10) : undefined,
    );
  }

  @Get('wallet/:steamId')
  wallet(@Param('steamId') steamId: string) {
    return this.svc.getWallet(steamId);
  }

  @Post('adjust')
  adjust(@CurrentUser() admin: JwtPayload, @Body() body: AdjustMeowcoinsDto) {
    return this.svc.adjust(body.steam_id, body.delta, actorOf(admin), body.reason);
  }

  @Post('set')
  set(@CurrentUser() admin: JwtPayload, @Body() body: SetMeowcoinsDto) {
    return this.svc.set(body.steam_id, body.balance, actorOf(admin), body.reason);
  }

  @Get('providers')
  providers() {
    return this.svc.listProviders();
  }

  @Post('providers')
  setProvider(@Body() body: SetProviderDto) {
    return this.svc.setProvider(body.key, body.enabled);
  }
}
