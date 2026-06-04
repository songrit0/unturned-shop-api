import { Module } from '@nestjs/common';
import { ScheduleModule } from '@nestjs/schedule';
import { TopupController, VcoinsController } from './topup.controller';
import { TopupService } from './topup.service';
import { TopupDbService } from './topup-db.service';
import { PlernpayService } from './plernpay.service';
import { TopupPollService } from './topup-poll.service';

/**
 * Real-money Vcoin top-up via PlernPay. Vcoin wallet + records live in a SEPARATE Pi5-local
 * MariaDB (TopupDbService). The global DbService (external shop DB) is injected READ-ONLY in
 * TopupService solely to resolve steam_id from sv_links.
 */
@Module({
  imports: [ScheduleModule.forRoot()],
  controllers: [TopupController, VcoinsController],
  providers: [TopupService, TopupDbService, PlernpayService, TopupPollService],
  exports: [TopupService],
})
export class TopupModule {}
