import { Module } from '@nestjs/common';
import { WebPinService } from './web-pin.service';

@Module({
  providers: [WebPinService],
  exports: [WebPinService],
})
export class WebPinModule {}
