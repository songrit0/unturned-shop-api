import { Module } from '@nestjs/common';
import { BotController } from './bot.controller';
import { BotPinController } from './bot-pin.controller';
import { UsersModule } from '../users/users.module';
import { P2pModule } from '../p2p/p2p.module';
import { WebPinModule } from '../web-pin/web-pin.module';

@Module({
  imports: [UsersModule, P2pModule, WebPinModule],
  controllers: [BotController, BotPinController],
})
export class BotModule {}
