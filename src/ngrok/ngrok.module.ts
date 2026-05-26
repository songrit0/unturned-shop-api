import { Module } from '@nestjs/common';
import { NgrokService } from './ngrok.service';

@Module({
  providers: [NgrokService],
  exports: [NgrokService],
})
export class NgrokModule {}
