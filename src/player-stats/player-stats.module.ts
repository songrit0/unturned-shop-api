import { Module } from '@nestjs/common';
import { PlayerStatsController } from './player-stats.controller';
import { PlayerStatsService } from './player-stats.service';

@Module({
  controllers: [PlayerStatsController],
  providers: [PlayerStatsService],
})
export class PlayerStatsModule {}
