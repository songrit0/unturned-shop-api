import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import configuration from './config/configuration';
import { DatabaseModule } from './database/database.module';
import { AuthModule } from './auth/auth.module';
import { UsersModule } from './users/users.module';
import { FirebaseModule } from './firebase/firebase.module';
import { NgrokModule } from './ngrok/ngrok.module';
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
import { MarketHistoryModule } from './market-history/market-history.module';
import { VaultsModule } from './vaults/vaults.module';
import { P2pModule } from './p2p/p2p.module';
import { ItemsSubmissionsModule } from './items-submissions/items-submissions.module';
import { PurchasesModule } from './purchases/purchases.module';
import { NotificationsModule } from './notifications/notifications.module';
import { BotModule } from './bot/bot.module';
import { VipModule } from './vip/vip.module';
import { HealthController } from './health/health.controller';
import { VersionController } from './health/version.controller';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true, load: [configuration] }),
    DatabaseModule,
    FirebaseModule,
    NgrokModule,
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
    MarketHistoryModule,
    VaultsModule,
    P2pModule,
    ItemsSubmissionsModule,
    PurchasesModule,
    NotificationsModule,
    BotModule,
    VipModule,
  ],
  controllers: [HealthController, VersionController],
})
export class AppModule {}
