import { Controller, Get, Query } from '@nestjs/common';
import { PlayerStatsService } from './player-stats.service';

@Controller('player-stats')
export class PlayerStatsController {
  constructor(private readonly service: PlayerStatsService) {}

  @Get('leaderboard')
  async leaderboard(@Query('limit') limit?: string) {
    const n = parseInt(limit ?? '10', 10);
    const players = await this.service.leaderboard(isNaN(n) ? 10 : n);
    return { players };
  }
}
