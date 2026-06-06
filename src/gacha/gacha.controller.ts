import { Body, Controller, Get, Post, Query, UseGuards } from '@nestjs/common';
import { IsIn, IsInt, Max, Min } from 'class-validator';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { JwtPayload } from '../auth/strategies/jwt.strategy';
import { GachaService } from './gacha.service';

class BuyDto {
  @IsInt() @Min(1) @Max(50) count!: number;
  @IsIn(['coins', 'meowcoins']) currency!: 'coins' | 'meowcoins';
}

/** Player-facing daily gacha. All endpoints require a logged-in (linked) user. */
@Controller('gacha')
@UseGuards(JwtAuthGuard)
export class GachaController {
  constructor(private readonly service: GachaService) {}

  @Get('state')
  state(@CurrentUser() user: JwtPayload) {
    return this.service.state(user);
  }

  @Post('spin')
  spin(@CurrentUser() user: JwtPayload) {
    return this.service.spin(user);
  }

  @Post('buy')
  buy(@CurrentUser() user: JwtPayload, @Body() body: BuyDto) {
    return this.service.buy(user, body.count, body.currency);
  }

  @Get('today')
  async today(@Query('limit') limit?: string) {
    const n = parseInt(limit ?? '20', 10);
    const entries = await this.service.today(isNaN(n) ? 20 : n);
    return { entries };
  }

  /** Active prize pool (display only) — used by the client to render the spin reel. */
  @Get('prizes')
  async prizes() {
    return { prizes: await this.service.displayPool() };
  }

  /** Top players who earn free spins by rank + the next reset time (home card). */
  @Get('rank-rewards')
  rankRewards() {
    return this.service.rankRewards();
  }
}
