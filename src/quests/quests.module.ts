import { Module } from '@nestjs/common';
import { QuestsService } from './quests.service';
import { AdminQuestsController, QuestsController } from './quests.controller';
import { UsersModule } from '../users/users.module';

@Module({
  imports: [UsersModule],
  controllers: [AdminQuestsController, QuestsController],
  providers: [QuestsService],
  exports: [QuestsService],
})
export class QuestsModule {}
