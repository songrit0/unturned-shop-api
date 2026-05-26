import { Controller, Post, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { JwtPayload } from '../auth/strategies/jwt.strategy';
import { LinkService } from './link.service';

@Controller('link')
@UseGuards(JwtAuthGuard)
export class LinkController {
  constructor(private readonly link: LinkService) {}

  /** POST /link/welcome — generate (or reuse) a one-time /link code for the current Discord user. */
  @Post('welcome')
  async welcome(@CurrentUser() user: JwtPayload) {
    return this.link.createWelcomeCode(user.sub);
  }
}
