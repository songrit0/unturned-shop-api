import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import configuration from './config/configuration';
import { DatabaseModule } from './database/database.module';
import { AuthModule } from './auth/auth.module';
import { UsersModule } from './users/users.module';
import { FirebaseModule } from './firebase/firebase.module';
import { MarketModule } from './market/market.module';
import { CoinsModule } from './coins/coins.module';
import { LinkModule } from './link/link.module';
import { BasketModule } from './basket/basket.module';
import { CodesModule } from './codes/codes.module';
import { TaxModule } from './tax/tax.module';
import { AdminModule } from './admin/admin.module';
import { PricingModule } from './pricing/pricing.module';
import { ItemTypesModule } from './item-types/item-types.module';
import { QuestsModule } from './quests/quests.module';
import { ItemsModule } from './items/items.module';
import { VehiclesModule } from './vehicles/vehicles.module';
import { MarketHistoryModule } from './market-history/market-history.module';
import { VaultsModule } from './vaults/vaults.module';
import { P2pModule } from './p2p/p2p.module';
import { P2pGarageModule } from './p2p-garage/p2p-garage.module';
import { ItemsSubmissionsModule } from './items-submissions/items-submissions.module';
import { PurchasesModule } from './purchases/purchases.module';
import { NotificationsModule } from './notifications/notifications.module';
import { BotModule } from './bot/bot.module';
import { VipModule } from './vip/vip.module';
import { TopupModule } from './topup/topup.module';
import { PlayerStatsModule } from './player-stats/player-stats.module';
import { PublicModule } from './public/public.module';
import { GachaModule } from './gacha/gacha.module';
import { DailyModule } from './daily/daily.module';
import { XpModule } from './xp/xp.module';
import { HelpModule } from './help/help.module';
import { HealthController } from './health/health.controller';
import { VersionController } from './health/version.controller';
import { ChatController } from './chat/chat.controller';
import { FilesController } from './files/files.controller';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true, load: [configuration] }),
    DatabaseModule,
    FirebaseModule,
    UsersModule,
    AuthModule,
    MarketModule,
    CoinsModule,
    LinkModule,
    BasketModule,
    CodesModule,
    TaxModule,
    AdminModule,
    PricingModule,
    ItemTypesModule,
    QuestsModule,
    ItemsModule,
    VehiclesModule,
    MarketHistoryModule,
    VaultsModule,
    P2pModule,
    P2pGarageModule,
    ItemsSubmissionsModule,
    PurchasesModule,
    NotificationsModule,
    BotModule,
    VipModule,
    TopupModule,
    PlayerStatsModule,
    PublicModule,
    GachaModule,
    DailyModule,
    XpModule,
    HelpModule,
  ],
  controllers: [HealthController, VersionController, ChatController, FilesController],
})
export class AppModule {}
