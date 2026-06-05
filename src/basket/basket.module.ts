import { Module } from '@nestjs/common';
import { BasketController } from './basket.controller';
import { BasketService } from './basket.service';
import { UsersModule } from '../users/users.module';
import { TopupModule } from '../topup/topup.module';

@Module({
  imports: [UsersModule, TopupModule],
  controllers: [BasketController],
  providers: [BasketService],
})
export class BasketModule {}
