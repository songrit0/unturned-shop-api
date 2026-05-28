import { Module } from '@nestjs/common';
import { VaultsService } from './vaults.service';
import { AdminVaultsController, VaultsController } from './vaults.controller';
import { UsersModule } from '../users/users.module';

@Module({
  imports: [UsersModule],
  controllers: [VaultsController, AdminVaultsController],
  providers: [VaultsService],
  exports: [VaultsService],
})
export class VaultsModule {}
