import { BadRequestException, Controller, Get, NotFoundException, Param, ParseIntPipe, Query } from '@nestjs/common';
import { MarketService, MarketKind } from './market.service';
import { MarketHistoryService, CandleInterval } from '../market-history/market-history.service';
import { PaginationQueryDto } from '../common/dto/pagination-query.dto';

const CANDLE_INTERVALS: CandleInterval[] = ['1m', '5m', '15m', '1h', '4h', '1d'];

function parseIsoOrDefault(v: string | undefined, fallback: Date): Date {
  if (!v) return fallback;
  const d = new Date(v);
  if (Number.isNaN(d.getTime())) throw new BadRequestException(`Invalid date: ${v}`);
  return d;
}

@Controller('market')
export class MarketController {
  constructor(
    private readonly market: MarketService,
    private readonly history: MarketHistoryService,
  ) {}

  /** GET /market?type=normal|bills|all&type_id=<id>&page=&limit=  (default: normal — excludes cash bills) */
  @Get()
  list(
    @Query() pq: PaginationQueryDto,
    @Query('type') type?: string,
    @Query('type_id') typeId?: string,
  ) {
    const kind: MarketKind = type === 'bills' || type === 'all' ? type : 'normal';
    let tid: number | null = null;
    if (typeId != null && typeId !== '' && typeId !== 'null') {
      const parsed = parseInt(typeId, 10);
      if (Number.isFinite(parsed) && parsed > 0) tid = parsed;
    }
    return this.market.list(kind, tid, pq.page, pq.limit);
  }

  /** GET /market/types — public read-only list of sv_item_types. Declared before :id to avoid route collision. */
  @Get('types')
  listTypes() {
    return this.market.listTypes();
  }

  /** GET /market/sell-prices?type_id=<id> — what a player receives for selling to the shop. Before :id. */
  @Get('sell-prices')
  sellPrices(@Query('type_id') typeId?: string) {
    let tid: number | null = null;
    if (typeId != null && typeId !== '' && typeId !== 'null') {
      const parsed = parseInt(typeId, 10);
      if (Number.isFinite(parsed) && parsed > 0) tid = parsed;
    }
    return this.market.sellPrices(tid);
  }

  /** GET /market/transactions?page=&limit=&kind=buy|sell|all — global cross-item transaction log. Declared before :id. */
  @Get('transactions')
  globalTransactions(
    @Query('page') page?: string,
    @Query('limit') limit?: string,
    @Query('kind') kind?: string,
  ) {
    const k = kind === 'buy' || kind === 'sell' ? kind : 'all';
    return this.history.transactionsGlobal(parseInt(page!, 10), parseInt(limit!, 10), k);
  }

  /** GET /market/:item_id/candles?interval=&from=&to= */
  @Get(':item_id/candles')
  candles(
    @Param('item_id', ParseIntPipe) itemId: number,
    @Query('interval') interval?: string,
    @Query('from') from?: string,
    @Query('to') to?: string,
  ) {
    const iv = (interval && (CANDLE_INTERVALS as string[]).includes(interval)
      ? (interval as CandleInterval)
      : '1h');
    if (interval && !(CANDLE_INTERVALS as string[]).includes(interval)) {
      throw new BadRequestException(`interval must be one of: ${CANDLE_INTERVALS.join(',')}`);
    }
    const toDate = parseIsoOrDefault(to, new Date());
    const fromDate = parseIsoOrDefault(from, new Date(toDate.getTime() - 24 * 3600 * 1000));
    return this.history.candles(itemId, iv, fromDate, toDate);
  }

  /** GET /market/:item_id/forecast */
  @Get(':item_id/forecast')
  async forecast(@Param('item_id', ParseIntPipe) itemId: number) {
    const f = await this.history.forecast(itemId);
    if (!f) throw new NotFoundException('Item not found');
    return f;
  }

  /** GET /market/:item_id/transactions?page=&limit= */
  @Get(':item_id/transactions')
  itemTransactions(
    @Param('item_id', ParseIntPipe) itemId: number,
    @Query('page') page?: string,
    @Query('limit') limit?: string,
  ) {
    return this.history.transactionsForItem(itemId, parseInt(page!, 10), parseInt(limit!, 10));
  }

  /** GET /market/:id?include_unlisted=1 — set include_unlisted to also return buy-only items (enabled_isforsell=0). */
  @Get(':id')
  async getOne(
    @Param('id', ParseIntPipe) id: number,
    @Query('include_unlisted') includeUnlisted?: string,
  ) {
    const include = includeUnlisted === '1' || includeUnlisted === 'true';
    const item = await this.market.getById(id, include);
    if (!item) throw new NotFoundException('Item not found');
    return item;
  }
}
