import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PassportStrategy } from '@nestjs/passport';
import { ExtractJwt, Strategy } from 'passport-jwt';

export interface JwtPayload {
  /** discord_id for Discord logins; for steam_pin logins it's the linked discord_id, or null if unlinked. */
  sub: string | null;
  username: string;
  avatar: string | null;
  steam_id: string | null;
  is_admin: boolean;
  /** How the token was obtained. Absent on legacy tokens (treat as 'discord'). */
  login_method?: 'discord' | 'steam_pin';
  iat?: number;
  exp?: number;
}

@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy, 'jwt') {
  constructor(cfg: ConfigService) {
    super({
      jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
      ignoreExpiration: false,
      secretOrKey: cfg.get<string>('jwt.secret'),
    });
  }

  async validate(payload: JwtPayload): Promise<JwtPayload> {
    return payload;
  }
}
