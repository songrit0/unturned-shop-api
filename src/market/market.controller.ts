import { Controller, Get, NotFoundException, Param, ParseIntPipe, Query } from '@nestjs/common';
import { MarketService, MarketKind } from './market.service';

@Controller('market')
export class MarketController {
  constructor(private readonly market: MarketService) {}

  /** GET /market?type=normal|bills|all  (default: normal — excludes cash bills) */
  @Get()
  list(@Query('type') type?: string) {
    const kind: MarketKind = type === 'bills' || type === 'all' ? type : 'normal';
    return this.market.list(kind);
  }

  @Get(':id')
  async getOne(@Param('id', ParseIntPipe) id: number) {
    const item = await this.market.getById(id);
    if (!item) throw new NotFoundException('Item not found');
    return item;
  }
}
