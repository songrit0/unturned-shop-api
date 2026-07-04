import { Controller, Get, Post, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { JwtPayload } from '../auth/strategies/jwt.strategy';
import { DailyService } from './daily.service';

/** Player-facing daily reward. All endpoints require a logged-in (linked) user. */
@Controller('daily')
@UseGuards(JwtAuthGuard)
export class DailyController {
  constructor(private readonly service: DailyService) {}

  @Get('status')
  status(@CurrentUser() user: JwtPayload) {
    return this.service.status(user);
  }

  /** Per-tier reward preview (normal vs what a VIP receives) — for the VIP-benefits UI. */
  @Get('preview')
  preview() {
    return this.service.tiersPreview();
  }

  @Post('claim')
  claim(@CurrentUser() user: JwtPayload) {
    return this.service.claim(user);
  }
}
