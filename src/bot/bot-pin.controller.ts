import { Body, Controller, Post, UseGuards } from '@nestjs/common';
import { IsString, Matches } from 'class-validator';
import { BotGuard } from '../common/guards/bot.guard';
import { WebPinService } from '../web-pin/web-pin.service';

class SetPinDto {
  /** 17-digit Steam64. */
  @IsString()
  @Matches(/^\d{17}$/, { message: 'steam_id must be a 17-digit Steam64' })
  steam_id!: string;

  /** Exactly 6 digits. */
  @IsString()
  @Matches(/^\d{6}$/, { message: 'pin must be exactly 6 digits' })
  pin!: string;
}

/**
 * Bot/plugin-only endpoint to set a player's web login PIN. BotGuard (X-Bot-Secret), not JWT.
 * The plugin's /shoppin command POSTs here; hashing lives only in the API.
 */
@Controller('bot')
@UseGuards(BotGuard)
export class BotPinController {
  constructor(private readonly webPin: WebPinService) {}

  /** POST /bot/steam-pin { steam_id, pin } -> { ok: true } */
  @Post('steam-pin')
  async setPin(@Body() body: SetPinDto): Promise<{ ok: true }> {
    await this.webPin.setPin(body.steam_id, body.pin);
    return { ok: true };
  }
}
