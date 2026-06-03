import { Module } from '@nestjs/common';
import { P2pGarageService } from './p2p-garage.service';
import { AdminP2pGarageController, P2pGarageController } from './p2p-garage.controller';
import { UsersModule } from '../users/users.module';

@Module({
  imports: [UsersModule],
  controllers: [P2pGarageController, AdminP2pGarageController],
  providers: [P2pGarageService],
  exports: [P2pGarageService],
})
export class P2pGarageModule {}
