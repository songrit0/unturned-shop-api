import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PassportStrategy } from '@nestjs/passport';
import { Request } from 'express';
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
      passReqToCallback: true,
    });
  }

  async validate(req: Request, payload: JwtPayload): Promise<JwtPayload> {
    // admin ส่ง X-Act-As-User: 1 เพื่อเทสทั้งระบบในมุมมองผู้เล่นปกติ
    // ลดสิทธิ์ได้อย่างเดียว (เช็ค is_admin จาก JWT ก่อน) — เพิ่มสิทธิ์ไม่ได้
    if (payload.is_admin && req.headers['x-act-as-user'] === '1') {
      return { ...payload, is_admin: false };
    }
    return payload;
  }
}
