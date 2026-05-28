import { Module } from '@nestjs/common';
import { ScheduleModule } from '@nestjs/schedule';
import { P2pService } from './p2p.service';
import { P2pExpireService } from './p2p-expire.service';
import { AdminP2pController, P2pConfigController, P2pController } from './p2p.controller';
import { UsersModule } from '../users/users.module';
import { VaultsModule } from '../vaults/vaults.module';

@Module({
  imports: [ScheduleModule.forRoot(), UsersModule, VaultsModule],
  controllers: [P2pController, AdminP2pController, P2pConfigController],
  providers: [P2pService, P2pExpireService],
  exports: [P2pService],
})
export class P2pModule {}
