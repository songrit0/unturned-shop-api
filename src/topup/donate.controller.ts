import { Body, Controller, Get, Post, UseGuards } from '@nestjs/common';
import { IsInt } from 'class-validator';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { JwtPayload } from '../auth/strategies/jwt.strategy';
import { DonateService } from './donate.service';

class ClaimDto {
  /** The donation tier to claim this month's reward for. */
  @IsInt()
  tier_id!: number;
}

/** Player-facing donate/battlepass endpoints. */
@Controller('donate')
@UseGuards(JwtAuthGuard)
export class DonateController {
  constructor(private readonly donate: DonateService) {}

  /** GET /donate/progress — this month's cap/goal progress + tiers (unlocked/claimed) for the caller. */
  @Get('progress')
  progress(@CurrentUser() user: JwtPayload) {
    return this.donate.progress(user);
  }

  /** POST /donate/claim — claim a tier's reward set as a redeem code (idempotent per month). */
  @Post('claim')
  claim(@CurrentUser() user: JwtPayload, @Body() body: ClaimDto) {
    return this.donate.claim(user, body.tier_id);
  }
}
