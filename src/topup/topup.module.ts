import { Module } from '@nestjs/common';
import { ScheduleModule } from '@nestjs/schedule';
import { TopupController, MeowcoinsController, TopupConfigController } from './topup.controller';
import { TopupService } from './topup.service';
import { TopupDbService } from './topup-db.service';
import { PlernpayService } from './plernpay.service';
import { ThunderService } from './thunder.service';
import { TopupPollService } from './topup-poll.service';
import { AdminMeowcoinsController } from './admin-meowcoins.controller';
import { AdminMeowcoinsService } from './admin-meowcoins.service';
import { MeowcoinWalletService } from './meowcoin-wallet.service';

/**
 * Real-money Meowcoin top-up via PlernPay (auto) + Thunder (slip upload). Meowcoin wallet + records
 * live in a SEPARATE Pi5-local MariaDB (TopupDbService). The global DbService (external shop DB)
 * is injected READ-ONLY in TopupService solely to resolve steam_id from sv_links.
 */
@Module({
  imports: [ScheduleModule.forRoot()],
  controllers: [TopupController, MeowcoinsController, TopupConfigController, AdminMeowcoinsController],
  providers: [TopupService, TopupDbService, PlernpayService, ThunderService, TopupPollService, AdminMeowcoinsService, MeowcoinWalletService],
  exports: [TopupService, MeowcoinWalletService],
})
export class TopupModule {}
