import { Module } from '@nestjs/common';
import { ScheduleModule } from '@nestjs/schedule';
import { TaxService } from './tax.service';

@Module({
  imports: [ScheduleModule.forRoot()],
  providers: [TaxService],
  exports: [TaxService],
})
export class TaxModule {}
