import { Module } from '@nestjs/common';
import { ItemsSubmissionsService } from './items-submissions.service';
import {
  AdminItemsSubmissionsController,
  ItemsSubmissionsController,
} from './items-submissions.controller';
import { UsersModule } from '../users/users.module';

@Module({
  imports: [UsersModule],
  controllers: [ItemsSubmissionsController, AdminItemsSubmissionsController],
  providers: [ItemsSubmissionsService],
  exports: [ItemsSubmissionsService],
})
export class ItemsSubmissionsModule {}
