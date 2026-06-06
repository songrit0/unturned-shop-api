import { Module } from '@nestjs/common';
import { GachaController } from './gacha.controller';
import { AdminGachaController } from './admin-gacha.controller';
import { GachaService } from './gacha.service';
import { UsersModule } from '../users/users.module';
import { PurchasesModule } from '../purchases/purchases.module';
import { TopupModule } from '../topup/topup.module';
import { PlayerStatsModule } from '../player-stats/player-stats.module';

/**
 * Daily lucky-draw (gacha). Free spins by leaderboard rank + buyable spins; rewards span
 * coins / meowcoins / items / vehicles / vip, delivered via the existing grant mechanisms.
 * DbService is global; the reward services come from their owning modules.
 */
@Module({
  imports: [UsersModule, PurchasesModule, TopupModule, PlayerStatsModule],
  controllers: [GachaController, AdminGachaController],
  providers: [GachaService],
})
export class GachaModule {}
