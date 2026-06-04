import { Module } from '@nestjs/common';
import { ScheduleModule } from '@nestjs/schedule';
import { TopupController, VcoinsController, TopupConfigController } from './topup.controller';
import { TopupService } from './topup.service';
import { TopupDbService } from './topup-db.service';
import { PlernpayService } from './plernpay.service';
import { ThunderService } from './thunder.service';
import { TopupPollService } from './topup-poll.service';
import { AdminVcoinsController } from './admin-vcoins.controller';
import { AdminVcoinsService } from './admin-vcoins.service';

/**
 * Real-money Vcoin top-up via PlernPay (auto) + Thunder (slip upload). Vcoin wallet + records
 * live in a SEPARATE Pi5-local MariaDB (TopupDbService). The global DbService (external shop DB)
 * is injected READ-ONLY in TopupService solely to resolve steam_id from sv_links.
 */
@Module({
  imports: [ScheduleModule.forRoot()],
  controllers: [TopupController, VcoinsController, TopupConfigController, AdminVcoinsController],
  providers: [TopupService, TopupDbService, PlernpayService, ThunderService, TopupPollService, AdminVcoinsService],
  exports: [TopupService],
})
export class TopupModule {}
