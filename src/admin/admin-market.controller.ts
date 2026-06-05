import { Body, Controller, Delete, Get, Param, ParseIntPipe, Post, Put, Query, UseGuards } from '@nestjs/common';
import { ArrayMaxSize, IsArray, IsBoolean, IsInt, IsNumber, IsOptional, Max, Min, ValidateNested } from 'class-validator';
import { Type } from 'class-transformer';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { AdminGuard } from '../common/guards/admin.guard';
import { PaginationQueryDto } from '../common/dto/pagination-query.dto';
import { AdminMarketService } from './admin-market.service';

class UpsertMarketDto {
  @IsInt() @Min(1) item_id!: number;
  @IsNumber() @Min(0) base_price!: number;
  @IsInt() @Min(1) target_stock!: number;
  @IsNumber() @Min(0) @Max(2) elasticity!: number;
  @IsInt() @Min(0) amount!: number;
  @IsOptional() @IsBoolean() enabled?: boolean;            // shop buys it
  @IsOptional() @IsBoolean() enabled_isforsell?: boolean;  // shop sells it
  // Meowcoin price; null/omitted clears it (not buyable with Meowcoin).
  @IsOptional() @IsInt() @Min(0) meowcoin_price?: number | null;
}

class ImportMarketDto {
  @IsArray()
  @ArrayMaxSize(2000)
  @ValidateNested({ each: true })
  @Type(() => UpsertMarketDto)
  items!: UpsertMarketDto[];
}

class ToggleDto { @IsBoolean() enabled!: boolean; }
class ForSaleDto { @IsBoolean() is_for_sale!: boolean; }

class BuyOnlyDto {
  @IsArray()
  @ArrayMaxSize(2000)
  @IsInt({ each: true })
  @Min(1, { each: true })
  item_ids!: number[];
}

@Controller('admin/market')
@UseGuards(JwtAuthGuard, AdminGuard)
export class AdminMarketController {
  constructor(private readonly svc: AdminMarketService) {}

  @Get() list(@Query() q: PaginationQueryDto) { return this.svc.listAll(q.page, q.limit); }

  // Must be declared BEFORE the ':id' route, otherwise 'export' is parsed as an id.
  @Get('export') exportAll() { return this.svc.exportAll(); }

  @Get(':id') getOne(@Param('id', ParseIntPipe) id: number) { return this.svc.getOne(id); }

  @Post('import')
  importMany(@Body() body: ImportMarketDto) {
    return this.svc.importMany(body.items.map(b => ({
      item_id: b.item_id,
      base_price: b.base_price, target_stock: b.target_stock, elasticity: b.elasticity,
      amount: b.amount,
      enabled: b.enabled !== false,
      enabledIsForSell: b.enabled_isforsell !== false,
      meowcoinPrice: b.meowcoin_price ?? null,
    })));
  }

  @Post()
  upsert(@Body() body: UpsertMarketDto) {
    return this.svc.upsert({
      item_id: body.item_id,
      base_price: body.base_price, target_stock: body.target_stock, elasticity: body.elasticity,
      amount: body.amount,
      enabled: body.enabled !== false,
      enabledIsForSell: body.enabled_isforsell !== false,
      meowcoinPrice: body.meowcoin_price ?? null,
    });
  }

  @Put(':id/enabled')
  toggle(@Param('id', ParseIntPipe) id: number, @Body() body: ToggleDto) {
    return this.svc.toggleEnabled(id, body.enabled);
  }

  @Put(':id/forsale')
  toggleForSale(@Param('id', ParseIntPipe) id: number, @Body() body: ForSaleDto) {
    return this.svc.toggleForSale(id, body.is_for_sale);
  }

  /** Set items to buy-only (enabled=1, enabled_isforsell=0); creates a default row if not in the market yet. */
  @Post('buy-only')
  buyOnly(@Body() body: BuyOnlyDto) {
    return this.svc.enableBuyOnly(body.item_ids);
  }

  @Delete(':id') remove(@Param('id', ParseIntPipe) id: number) { return this.svc.remove(id); }
}
