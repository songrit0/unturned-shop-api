import {
  Body,
  Controller,
  Get,
  HttpException,
  HttpStatus,
  Post,
  Req,
  Res,
  UnauthorizedException,
  UseGuards,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AuthGuard } from '@nestjs/passport';
import { IsString, Matches } from 'class-validator';
import { Request, Response } from 'express';
import { AuthService, DiscordUser } from './auth.service';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { JwtPayload } from './strategies/jwt.strategy';
import { WebPinService } from '../web-pin/web-pin.service';

class SteamPinLoginDto {
  /** 17-digit Steam64 (from the ?id= the web passes through; untrusted — the PIN is the credential). */
  @IsString()
  @Matches(/^\d{17}$/, { message: 'invalid' })
  steam_id!: string;

  /** Exactly 6 digits. */
  @IsString()
  @Matches(/^\d{6}$/, { message: 'invalid' })
  pin!: string;
}

@Controller('auth')
export class AuthController {
  constructor(
    private readonly auth: AuthService,
    private readonly cfg: ConfigService,
    private readonly webPin: WebPinService,
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

  /**
   * Public Steam-ID + PIN login. POST { steam_id, pin } -> { token }.
   * Anti-enumeration: wrong PIN and no-PIN both return a generic 401 { error: 'invalid' }.
   * A live lockout returns 429 { error: 'too_many_attempts', retry_after: <sec> }.
   */
  @Post('steam-pin')
  async steamPinLogin(@Body() body: SteamPinLoginDto): Promise<{ token: string }> {
    const result = await this.webPin.verify(body.steam_id, body.pin);
    if (!result.ok) {
      if (result.reason === 'locked') {
        throw new HttpException(
          { error: 'too_many_attempts', retry_after: result.retryAfterSec },
          HttpStatus.TOO_MANY_REQUESTS,
        );
      }
      throw new UnauthorizedException({ error: 'invalid' });
    }
    const { token } = await this.auth.issueSteamJwt(body.steam_id);
    return { token };
  }
}
