import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { UsersService } from '../users/users.service';
import { JwtPayload } from './strategies/jwt.strategy';

export interface DiscordUser {
  id: string;
  username: string;
  /** Raw Discord username (login handle). */
  discord_username?: string;
  /** Discord display name (`global_name`), or null if unset. */
  discord_global_name?: string | null;
  avatar: string | null;
}

@Injectable()
export class AuthService {
  constructor(
    private readonly cfg: ConfigService,
    private readonly jwt: JwtService,
    private readonly users: UsersService,
  ) {}

  async issueJwt(user: DiscordUser): Promise<{ token: string; payload: JwtPayload }> {
    const steamId = await this.users.findSteamByDiscord(user.id);
    // Best-effort cache of the Discord identity on the existing sv_links row.
    // No-op if the user hasn't linked yet — bot's /link flow handles row creation.
    if (user.discord_username !== undefined) {
      await this.users.updateDiscordNames(
        user.id,
        user.discord_username,
        user.discord_global_name ?? null,
      );
    }
    const adminIds = this.cfg.get<string[]>('adminDiscordIds') || [];
    const payload: JwtPayload = {
      sub: user.id,
      username: user.username,
      avatar: user.avatar,
      steam_id: steamId,
      is_admin: adminIds.includes(user.id),
    };
    const token = await this.jwt.signAsync(payload);
    return { token, payload };
  }

  /** Build the live "me" payload by reading current link state from DB. */
  async me(jwt: JwtPayload) {
    const steamId = await this.users.findSteamByDiscord(jwt.sub);
    return {
      discord_id: jwt.sub,
      username: jwt.username,
      avatar: jwt.avatar,
      steam_id: steamId,
      linked: !!steamId,
      is_admin: jwt.is_admin,
    };
  }
}
