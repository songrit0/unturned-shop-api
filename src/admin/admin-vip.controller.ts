import {
  Body, Controller, Delete, Get, Param, Patch, Post, Query, UseGuards,
} from '@nestjs/common';
import {
  IsBoolean, IsInt, IsISO8601, IsOptional, IsString, MaxLength, Min,
} from 'class-validator';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { AdminGuard } from '../common/guards/admin.guard';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { JwtPayload } from '../auth/strategies/jwt.strategy';
import { AdminVipService } from './admin-vip.service';

class PackageDto {
  @IsString() @MaxLength(32) tier!: string;
  @IsString() @MaxLength(64) group_id!: string;
  @IsInt() @Min(1) days!: number;
  @IsInt() @Min(0) price_coins!: number;
  @IsOptional() @IsInt() @Min(0) price_meowcoins?: number | null;
  @IsOptional() @IsString() @MaxLength(64) label?: string;
  @IsOptional() @IsInt() sort?: number;
  @IsOptional() @IsBoolean() enabled?: boolean;
}

class PackagePatchDto {
  @IsOptional() @IsString() @MaxLength(32) tier?: string;
  @IsOptional() @IsString() @MaxLength(64) group_id?: string;
  @IsOptional() @IsInt() @Min(1) days?: number;
  @IsOptional() @IsInt() @Min(0) price_coins?: number;
  @IsOptional() @IsInt() @Min(0) price_meowcoins?: number | null;
  @IsOptional() @IsString() @MaxLength(64) label?: string;
  @IsOptional() @IsInt() sort?: number;
  @IsOptional() @IsBoolean() enabled?: boolean;
}

class ExtendDto {
  @IsString() @MaxLength(64) group_id!: string;
  @IsInt() @Min(1) days!: number;
}

class SetExpiryDto {
  @IsString() @MaxLength(64) group_id!: string;
  @IsISO8601() expires_at!: string; // UTC ISO 8601
}

class RevokeDto {
  @IsString() @MaxLength(64) group_id!: string;
}

@Controller('admin/vip')
@UseGuards(JwtAuthGuard, AdminGuard)
export class AdminVipController {
  constructor(private readonly svc: AdminVipService) {}

  // ---- packages ----
  @Get('packages')
  listPackages() {
    return this.svc.listPackages();
  }

  @Post('packages')
  createPackage(@Body() body: PackageDto) {
    return this.svc.createPackage(body);
  }

  @Patch('packages/:id')
  updatePackage(@Param('id') id: string, @Body() body: PackagePatchDto) {
    return this.svc.updatePackage(parseInt(id, 10), body);
  }

  @Delete('packages/:id')
  deletePackage(@Param('id') id: string) {
    return this.svc.deletePackage(parseInt(id, 10));
  }

  // ---- grants ----
  @Get('grants')
  listGrants(
    @Query('page') page?: string,
    @Query('limit') limit?: string,
    @Query('q') q?: string,
    @Query('active') active?: string,
  ) {
    return this.svc.listGrants(parseInt(page!, 10), parseInt(limit!, 10), q || '', active === '1' || active === 'true');
  }

  @Get('grants/:steamId')
  grantsForUser(@Param('steamId') steamId: string) {
    return this.svc.grantsForUser(steamId);
  }

  @Post('grants/:steamId/extend')
  extend(@CurrentUser() admin: JwtPayload, @Param('steamId') steamId: string, @Body() body: ExtendDto) {
    return this.svc.extend(steamId, body.group_id, body.days, admin.sub ?? 'admin');
  }

  @Post('grants/:steamId/set')
  setExpiry(@CurrentUser() admin: JwtPayload, @Param('steamId') steamId: string, @Body() body: SetExpiryDto) {
    return this.svc.setExpiry(steamId, body.group_id, body.expires_at, admin.sub ?? 'admin');
  }

  @Post('grants/:steamId/revoke')
  revoke(@CurrentUser() admin: JwtPayload, @Param('steamId') steamId: string, @Body() body: RevokeDto) {
    return this.svc.revoke(steamId, body.group_id, admin.sub ?? 'admin');
  }
}
