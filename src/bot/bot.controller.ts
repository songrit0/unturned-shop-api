import {
  BadRequestException,
  Body,
  Controller,
  Param,
  ParseIntPipe,
  Post,
  UseGuards,
} from '@nestjs/common';
import { IsString, Matches } from 'class-validator';
import { BotGuard } from '../common/guards/bot.guard';
import { UsersService } from '../users/users.service';
import { P2pService } from '../p2p/p2p.service';

class BotBuyDto {
  /** Discord snowflake of the buyer (the bot authenticated them via the interaction). */
  @IsString()
  @Matches(/^\d{5,32}$/, { message: 'discord_id must be a numeric snowflake' })
  discord_id!: string;
}

/**
 * Bot-only service endpoints, isolated from the JWT-guarded user controllers.
 * Authenticated by BotGuard (X-Bot-Secret == BOT_API_SECRET), NOT by user JWT.
 */
@Controller('bot/p2p/listings')
@UseGuards(BotGuard)
export class BotController {
  constructor(
    private readonly users: UsersService,
    private readonly p2p: P2pService,
  ) {}

  /**
   * POST /bot/p2p/listings/:id/buy  { discord_id }
   * Buys the listing on behalf of the Discord user and mints the redeem code immediately.
   * Errors bubble from the service as HTTP: 402 insufficient_funds, 409 listing_no_longer_active,
   * 400 cannot_buy_own_listing, 404 Listing not found.
   */
  @Post(':id(\\d+)/buy')
  async buy(@Param('id', ParseIntPipe) id: number, @Body() body: BotBuyDto) {
    const steam = await this.users.findSteamByDiscord(body.discord_id);
    if (!steam) throw new BadRequestException('discord_not_linked');
    return this.p2p.buyAndClaim(steam, id);
  }
}
