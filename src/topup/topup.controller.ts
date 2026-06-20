import {
  Body,
  Controller,
  Get,
  Param,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { IsIn, IsInt, IsOptional, IsString, MaxLength } from 'class-validator';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { JwtPayload } from '../auth/strategies/jwt.strategy';
import { PaginationQueryDto } from '../common/dto/pagination-query.dto';
import { TopupService } from './topup.service';
import { TopupProvider } from './topup.types';

class CreateTopupDto {
  /** Whole baht to charge. Range enforced server-side against TOPUP_MIN/MAX_BAHT. */
  @IsInt()
  baht!: number;

  /** Payment provider. Defaults to 'plernpay'. Must be enabled in topup_providers. */
  @IsOptional()
  @IsIn(['plernpay', 'thunder'])
  provider?: TopupProvider;
}

class ThunderVerifyDto {
  @IsString() ref!: string;
  /** Base64-encoded bank-transfer slip image. */
  @IsString() slip_base64!: string;
}

class BmcClaimDto {
  /** Base64-encoded screenshot proving the BuyMeACoffee donation. */
  @IsString() @MaxLength(10_000_000) screenshot_base64!: string;
  @IsOptional() @IsString() @MaxLength(255) note?: string;
}

@Controller('topup')
@UseGuards(JwtAuthGuard)
export class TopupController {
  constructor(private readonly topup: TopupService) {}

  @Post('create')
  create(@CurrentUser() user: JwtPayload, @Body() body: CreateTopupDto) {
    return this.topup.create(user, body.baht, body.provider ?? 'plernpay');
  }

  @Post('thunder/verify')
  verifyThunder(@CurrentUser() user: JwtPayload, @Body() body: ThunderVerifyDto) {
    return this.topup.thunderVerify(user, body.ref, body.slip_base64);
  }

  /** Manual fallback when a BuyMeACoffee donation's webhook couldn't auto-attribute it. */
  @Post('bmc/claim')
  createBmcClaim(@CurrentUser() user: JwtPayload, @Body() body: BmcClaimDto) {
    return this.topup.createBmcClaim(user, body.screenshot_base64, body.note);
  }

  @Get('bmc/claims')
  myBmcClaims(@CurrentUser() user: JwtPayload) {
    return this.topup.myBmcClaims(user);
  }

  @Get('me')
  history(@CurrentUser() user: JwtPayload, @Query() q: PaginationQueryDto) {
    return this.topup.history(user, q.page, q.limit);
  }

  @Get(':ref')
  getOne(@CurrentUser() user: JwtPayload, @Param('ref') ref: string) {
    return this.topup.getOwned(user, ref);
  }
}

@Controller('meowcoins')
@UseGuards(JwtAuthGuard)
export class MeowcoinsController {
  constructor(private readonly topup: TopupService) {}

  @Get('me')
  me(@CurrentUser() user: JwtPayload) {
    return this.topup.meowcoinBalance(user);
  }
}

/** Public top-up config so the web can gate its UI (admin_only) and show the rate/limits. No auth. */
@Controller('config/topup')
export class TopupConfigController {
  constructor(private readonly topup: TopupService) {}

  @Get()
  config() {
    return this.topup.publicConfig();
  }
}
