import { Body, Controller, Delete, Get, HttpCode, Post, UseGuards } from '@nestjs/common';
import { IsInt, IsOptional, Min } from 'class-validator';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { JwtPayload } from '../auth/strategies/jwt.strategy';
import { BasketService } from './basket.service';

class BasketItemDto {
  @IsInt() item_id!: number;
  @IsOptional() @IsInt() @Min(1) qty?: number;
}

class BasketSetDto {
  @IsInt() item_id!: number;
  @IsInt() @Min(0) qty!: number;
}

@Controller('basket')
@UseGuards(JwtAuthGuard)
export class BasketController {
  constructor(private readonly basket: BasketService) {}

  @Get()
  view(@CurrentUser() user: JwtPayload) {
    return this.basket.view(user.sub);
  }

  @Post('add')
  @HttpCode(200)
  async add(@CurrentUser() user: JwtPayload, @Body() body: BasketItemDto) {
    this.basket.add(user.sub, body.item_id, body.qty || 1);
    return this.basket.view(user.sub);
  }

  @Post('set')
  @HttpCode(200)
  async setQty(@CurrentUser() user: JwtPayload, @Body() body: BasketSetDto) {
    this.basket.setQty(user.sub, body.item_id, body.qty);
    return this.basket.view(user.sub);
  }

  @Post('remove')
  @HttpCode(200)
  async remove(@CurrentUser() user: JwtPayload, @Body() body: BasketItemDto) {
    this.basket.remove(user.sub, body.item_id);
    return this.basket.view(user.sub);
  }

  @Delete()
  @HttpCode(200)
  async clear(@CurrentUser() user: JwtPayload) {
    this.basket.clear(user.sub);
    return this.basket.view(user.sub);
  }

  @Post('checkout')
  @HttpCode(200)
  checkout(@CurrentUser() user: JwtPayload) {
    return this.basket.checkout(user.sub);
  }
}
