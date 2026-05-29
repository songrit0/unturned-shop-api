import { CanActivate, ExecutionContext, ForbiddenException, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { timingSafeEqual } from 'crypto';

/**
 * Service-to-service auth for bot->API calls. Requires header `X-Bot-Secret` to equal the
 * configured BOT_API_SECRET, compared in constant time.
 *
 * Fails CLOSED: if BOT_API_SECRET is unset/empty, every request is rejected (a missing env
 * must never make the guard pass). The secret authenticates the BOT, not an end user — the
 * caller may act on behalf of any discord_id in the request body.
 */
@Injectable()
export class BotGuard implements CanActivate {
  constructor(private readonly cfg: ConfigService) {}

  canActivate(ctx: ExecutionContext): boolean {
    const expected = this.cfg.get<string>('botApiSecret') || '';
    if (!expected) throw new ForbiddenException('bot_auth_unavailable');

    const req = ctx.switchToHttp().getRequest();
    const provided = (req.headers?.['x-bot-secret'] ?? '') as string;
    if (typeof provided !== 'string' || provided.length === 0) {
      throw new ForbiddenException('bot_auth_failed');
    }

    const a = Buffer.from(provided);
    const b = Buffer.from(expected);
    // timingSafeEqual throws on length mismatch; check length first (not secret-dependent here).
    if (a.length !== b.length || !timingSafeEqual(a, b)) {
      throw new ForbiddenException('bot_auth_failed');
    }
    return true;
  }
}
