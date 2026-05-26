import { Controller, Get, Req, Res, UseGuards } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AuthGuard } from '@nestjs/passport';
import { Request, Response } from 'express';
import { AuthService, DiscordUser } from './auth.service';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { JwtPayload } from './strategies/jwt.strategy';

@Controller('auth')
export class AuthController {
  constructor(
    private readonly auth: AuthService,
    private readonly cfg: ConfigService,
  ) {}

  /** Kicks the user to Discord's OAuth consent page. */
  @Get('discord')
  @UseGuards(AuthGuard('discord'))
  discordLogin(): void { /* passport handles the redirect */ }

  /** Discord redirects here after consent with `?code=...` */
  @Get('discord/callback')
  @UseGuards(AuthGuard('discord'))
  async discordCallback(@Req() req: Request, @Res() res: Response) {
    const user = req.user as DiscordUser;
    const { token } = await this.auth.issueJwt(user);
    const frontend = this.cfg.get<string>('frontendUrl');
    res.redirect(`${frontend}/auth/callback?token=${encodeURIComponent(token)}`);
  }

  @Get('me')
  @UseGuards(JwtAuthGuard)
  me(@CurrentUser() user: JwtPayload) {
    return this.auth.me(user);
  }
}
