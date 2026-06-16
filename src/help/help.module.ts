import { Module } from '@nestjs/common';
import { HelpController } from './help.controller';
import { AdminHelpController } from './admin-help.controller';
import { HelpService } from './help.service';

@Module({
  controllers: [HelpController, AdminHelpController],
  providers: [HelpService],
  exports: [HelpService],
})
export class HelpModule {}
