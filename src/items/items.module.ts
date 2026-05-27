import { Module } from '@nestjs/common';
import { ItemsService } from './items.service';
import { AdminItemsController, ItemsController } from './items.controller';

@Module({
  controllers: [AdminItemsController, ItemsController],
  providers: [ItemsService],
  exports: [ItemsService],
})
export class ItemsModule {}
