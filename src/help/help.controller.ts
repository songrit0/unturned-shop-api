import { Controller, Get, Param } from '@nestjs/common';
import { HelpService } from './help.service';

/** Public read of the in-game help topics (for the website; no auth). */
@Controller('help')
export class HelpController {
  constructor(private readonly help: HelpService) {}

  @Get()
  list() {
    return this.help.listPublic();
  }

  @Get(':id')
  get(@Param('id') id: string) {
    return this.help.getPublic(parseInt(id, 10));
  }
}
