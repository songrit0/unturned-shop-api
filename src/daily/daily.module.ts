import { Module } from '@nestjs/common';
import { DailyController } from './daily.controller';
import { AdminDailyController } from './admin-daily.controller';
import { DailyService } from './daily.service';
import { UsersModule } from '../users/users.module';
import { PurchasesModule } from '../purchases/purchases.module';

/**
 * Daily reward claimed on the website. Flat (same reward each day), two tiers
 * (normal vs VIP, VIP resolved from an active sv_vip_grants row). Each tier grants
 * coins (sv_coins) + items/vehicles delivered via a single 1-use rc_code. The whole
 * claim is one atomic shop-DB transaction gated by UNIQUE(steam_id, claim_date).
 * DbService is global; UsersService + PurchasesService come from their owning modules.
 */
@Module({
  imports: [UsersModule, PurchasesModule],
  controllers: [DailyController, AdminDailyController],
  providers: [DailyService],
})
export class DailyModule {}
