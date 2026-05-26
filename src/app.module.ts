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
  ],
  controllers: [HealthController, VersionController],
})
export class AppModule {}
