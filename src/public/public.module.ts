import { Module } from '@nestjs/common';
import { PublicController } from './public.controller';
import { PublicService } from './public.service';
import { TopupModule } from '../topup/topup.module';
import { PlayerStatsModule } from '../player-stats/player-stats.module';

/**
 * Public (no-auth) landing-page aggregates for the login screen. DbService is global;
 * TopupService + PlayerStatsService come from their owning modules.
 */
@Module({
  imports: [TopupModule, PlayerStatsModule],
  controllers: [PublicController],
  providers: [PublicService],
})
export class PublicModule {}
