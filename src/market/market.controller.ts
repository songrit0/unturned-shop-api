import { Controller, Get, NotFoundException, Param, ParseIntPipe, Query } from '@nestjs/common';
import { MarketService, MarketKind } from './market.service';

@Controller('market')
export class MarketController {
  constructor(private readonly market: MarketService) {}

  /** GET /market?type=normal|bills|all&type_id=<id>  (default: normal — excludes cash bills) */
  @Get()
  list(@Query('type') type?: string, @Query('type_id') typeId?: string) {
    const kind: MarketKind = type === 'bills' || type === 'all' ? type : 'normal';
    let tid: number | null = null;
    if (typeId != null && typeId !== '' && typeId !== 'null') {
      const parsed = parseInt(typeId, 10);
      if (Number.isFinite(parsed) && parsed > 0) tid = parsed;
    }
    return this.market.list(kind, tid);
  }

  /** GET /market/types — public read-only list of sv_item_types (for frontend dropdown). Declared before :id to avoid route collision. */
  @Get('types')
  listTypes() {
    return this.market.listTypes();
  }

  @Get(':id')
  async getOne(@Param('id', ParseIntPipe) id: number) {
    const item = await this.market.getById(id);
    if (!item) throw new NotFoundException('Item not found');
    return item;
  }
}
