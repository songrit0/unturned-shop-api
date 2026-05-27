import { Module } from '@nestjs/common';
import { ItemTypesService } from './item-types.service';
import { AdminItemTypesController, AdminMarketTypeController } from './item-types.controller';
import { AdminModule } from '../admin/admin.module';

@Module({
  imports: [AdminModule],
  controllers: [AdminItemTypesController, AdminMarketTypeController],
  providers: [ItemTypesService],
  exports: [ItemTypesService],
})
export class ItemTypesModule {}
