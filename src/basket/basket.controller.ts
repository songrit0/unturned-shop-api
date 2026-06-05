import {
  Body,
  Controller,
  Delete,
  ForbiddenException,
  Get,
  HttpCode,
  Post,
  UseGuards,
} from '@nestjs/common';
import { IsIn, IsInt, IsOptional, Min } from 'class-validator';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { JwtPayload } from '../auth/strategies/jwt.strategy';
import { UsersService } from '../users/users.service';
import { BasketService, BasketKind, Currency } from './basket.service';

class BasketItemDto {
  @IsInt() item_id!: number;
  @IsOptional() @IsInt() @Min(1) qty?: number;
  @IsOptional() @IsIn(['item', 'vehicle']) kind?: BasketKind;
}

class BasketSetDto {
  @IsInt() item_id!: number;
  @IsInt() @Min(0) qty!: number;
  @IsOptional() @IsIn(['item', 'vehicle']) kind?: BasketKind;
}

class CheckoutDto {
  @IsOptional() @IsIn(['coin', 'meowcoin']) currency?: Currency;
}

@Controller('basket')
@UseGuards(JwtAuthGuard)
export class BasketController {
  constructor(
    private readonly basket: BasketService,
    private readonly users: UsersService,
  ) {}

  /**
   * The basket is keyed on steam_id, so it works for both Discord and steam-pin logins.
   * The steam-pin JWT carries steam_id directly; a Discord JWT may need the sv_links lookup.
   */
  private async requireSteam(user: JwtPayload): Promise<string> {
    const steam = user.steam_id ?? (await this.users.findSteamByDiscord(user.sub));
    if (!steam) throw new ForbiddenException('Account not linked to Steam');
    return steam;
  }

  @Get()
  async view(@CurrentUser() user: JwtPayload) {
    return this.basket.view(await this.requireSteam(user));
  }

  @Post('add')
  @HttpCode(200)
  async add(@CurrentUser() user: JwtPayload, @Body() body: BasketItemDto) {
    const steam = await this.requireSteam(user);
    this.basket.add(steam, body.item_id, body.qty || 1, body.kind ?? 'item');
    return this.basket.view(steam);
  }

  @Post('set')
  @HttpCode(200)
  async setQty(@CurrentUser() user: JwtPayload, @Body() body: BasketSetDto) {
    const steam = await this.requireSteam(user);
    this.basket.setQty(steam, body.item_id, body.qty, body.kind ?? 'item');
    return this.basket.view(steam);
  }

  @Post('remove')
  @HttpCode(200)
  async remove(@CurrentUser() user: JwtPayload, @Body() body: BasketItemDto) {
    const steam = await this.requireSteam(user);
    this.basket.remove(steam, body.item_id, body.kind ?? 'item');
    return this.basket.view(steam);
  }

  @Delete()
  @HttpCode(200)
  async clear(@CurrentUser() user: JwtPayload) {
    const steam = await this.requireSteam(user);
    this.basket.clear(steam);
    return this.basket.view(steam);
  }

  @Post('checkout')
  @HttpCode(200)
  async checkout(@CurrentUser() user: JwtPayload, @Body() body: CheckoutDto) {
    return this.basket.checkout(await this.requireSteam(user), body?.currency ?? 'coin');
  }
}
