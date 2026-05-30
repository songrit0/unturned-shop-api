import { Module } from '@nestjs/common';
import { UsersModule } from '../users/users.module';
import { VipController } from './vip.controller';
import { VipService } from './vip.service';

@Module({
  imports: [UsersModule],
  controllers: [VipController],
  providers: [VipService],
})
export class VipModule {}
