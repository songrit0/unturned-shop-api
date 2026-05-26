import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PassportStrategy } from '@nestjs/passport';
import { Strategy } from 'passport-discord';

export interface DiscordProfile {
  id: string; username: string; discriminator: string; avatar: string | null;
  global_name?: string;
}

@Injectable()
export class DiscordStrategy extends PassportStrategy(Strategy, 'discord') {
  constructor(cfg: ConfigService) {
    super({
      clientID: cfg.get<string>('discord.clientId'),
      clientSecret: cfg.get<string>('discord.clientSecret'),
      callbackURL: cfg.get<string>('discord.redirectUri'),
      scope: ['identify'],
    });
  }

  validate(_accessToken: string, _refreshToken: string, profile: DiscordProfile) {
    // returned object becomes req.user inside the controller
    return {
      id: profile.id,
      username: profile.global_name || profile.username,
      avatar: profile.avatar,
    };
  }
}
