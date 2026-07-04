import { Controller, Get, Query } from '@nestjs/common';
import { PublicService } from './public.service';

/**
 * Unauthenticated landing-page data. NO guards — every endpoint here must be safe to expose
 * without a JWT (read-only public aggregates only: server status, latest market, donation
 * totals, top players).
 */
@Controller('public')
export class PublicController {
  constructor(private readonly service: PublicService) {}

  /** One round-trip for the login/landing page. */
  @Get('landing')
  async landing(
    @Query('p2pLimit') p2pLimit?: string,
    @Query('topLimit') topLimit?: string,
  ) {
    const p = parseInt(p2pLimit ?? '8', 10);
    const t = parseInt(topLimit ?? '10', 10);
    return this.service.landing(isNaN(p) ? 8 : p, isNaN(t) ? 10 : t);
  }

  @Get('server-status')
  serverStatus() {
    return this.service.serverStatus();
  }

  /** Who's online right now (name + total playtime), for the header widget. */
  @Get('online-players')
  onlinePlayers() {
    return this.service.onlinePlayers();
  }
}
