import { Module } from '@nestjs/common';
import { UsersModule } from '../users/users.module';
import { VipController } from './vip.controller';
import { VipService } from './vip.service';
import { TopupModule } from '../topup/topup.module';

@Module({
  imports: [UsersModule, TopupModule],
  controllers: [VipController],
  providers: [VipService],
})
export class VipModule {}
