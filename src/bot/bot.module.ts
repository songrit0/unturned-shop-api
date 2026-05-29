import { Module } from '@nestjs/common';
import { BotController } from './bot.controller';
import { UsersModule } from '../users/users.module';
import { P2pModule } from '../p2p/p2p.module';

@Module({
  imports: [UsersModule, P2pModule],
  controllers: [BotController],
})
export class BotModule {}
