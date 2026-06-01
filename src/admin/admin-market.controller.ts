import { Body, Controller, Delete, Get, Param, ParseIntPipe, Post, Put, Query, UseGuards } from '@nestjs/common';
import { ArrayMaxSize, IsArray, IsBoolean, IsInt, IsNumber, IsOptional, IsString, Max, MaxLength, Min, ValidateNested } from 'class-validator';
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
  @IsOptional() @IsBoolean() enabled?: boolean;
  // Allow creating a buy-only entry when the item isn't in the master catalog.
  @IsOptional() @IsBoolean() create_if_missing?: boolean;
  @IsOptional() @IsString() @MaxLength(128) name?: string;
  @IsOptional() @IsString() @MaxLength(512) image_url?: string;
}

class ImportMarketDto {
  @IsArray()
  @ArrayMaxSize(2000)
  @ValidateNested({ each: true })
  @Type(() => UpsertMarketDto)
  items!: UpsertMarketDto[];
}

class ToggleDto { @IsBoolean() enabled!: boolean; }

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
    })));
  }

  @Post()
  upsert(@Body() body: UpsertMarketDto) {
    return this.svc.upsert({
      item_id: body.item_id,
      base_price: body.base_price, target_stock: body.target_stock, elasticity: body.elasticity,
      amount: body.amount,
      enabled: body.enabled !== false,
      createIfMissing: body.create_if_missing === true,
      name: body.name,
      imageUrl: body.image_url ?? null,
    });
  }

  @Put(':id/enabled')
  toggle(@Param('id', ParseIntPipe) id: number, @Body() body: ToggleDto) {
    return this.svc.toggleEnabled(id, body.enabled);
  }

  @Delete(':id') remove(@Param('id', ParseIntPipe) id: number) { return this.svc.remove(id); }
}
