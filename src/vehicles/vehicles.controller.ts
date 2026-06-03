import {
  Body, Controller, Delete, Get, NotFoundException, Param, ParseIntPipe, Post, Put, Query, UseGuards,
} from '@nestjs/common';
import { IsInt, IsOptional, IsString, MaxLength, Min } from 'class-validator';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { AdminGuard } from '../common/guards/admin.guard';
import { PaginationQueryDto } from '../common/dto/pagination-query.dto';
import { VehiclesService } from './vehicles.service';
import { VehicleMarketService } from './vehicle-market.service';

class CreateVehicleDto {
  @IsInt() @Min(1) id!: number;
  @IsString() @MaxLength(64) name!: string;
  @IsOptional() @IsString() @MaxLength(512) description?: string;
  @IsOptional() @IsString() @MaxLength(512) image_url?: string;
  @IsOptional() @IsInt() @Min(1) type_id?: number;
}

class UpdateVehicleDto {
  @IsString() @MaxLength(64) name!: string;
  @IsOptional() @IsString() @MaxLength(512) description?: string;
  @IsOptional() @IsString() @MaxLength(512) image_url?: string;
  @IsOptional() @IsInt() @Min(1) type_id?: number;
}

function parseIntQuery(v: string | undefined): number | null {
  if (v == null || v === '' || v === 'null') return null;
  const n = parseInt(v, 10);
  return Number.isFinite(n) && n > 0 ? n : null;
}

@Controller('admin/vehicles')
@UseGuards(JwtAuthGuard, AdminGuard)
export class AdminVehiclesController {
  constructor(private readonly svc: VehiclesService) {}

  @Get()
  list(@Query() pq: PaginationQueryDto, @Query('q') q?: string, @Query('type_id') typeId?: string) {
    return this.svc.list({ q: q || undefined, type_id: parseIntQuery(typeId), page: pq.page, limit: pq.limit });
  }

  @Get(':id(\\d+)') getOne(@Param('id', ParseIntPipe) id: number) { return this.svc.getOne(id); }

  @Post()
  create(@Body() body: CreateVehicleDto) {
    return this.svc.create(body.id, {
      name: body.name,
      description: body.description ?? null,
      image_url: body.image_url ?? null,
      type_id: body.type_id ?? null,
    });
  }

  @Put(':id(\\d+)')
  update(@Param('id', ParseIntPipe) id: number, @Body() body: UpdateVehicleDto) {
    return this.svc.update(id, {
      name: body.name,
      description: body.description ?? null,
      image_url: body.image_url ?? null,
      type_id: body.type_id ?? null,
    });
  }

  @Delete(':id(\\d+)') remove(@Param('id', ParseIntPipe) id: number) { return this.svc.remove(id); }
}

@Controller('vehicles')
export class VehiclesController {
  constructor(private readonly svc: VehiclesService) {}

  @Get()
  list(@Query() pq: PaginationQueryDto, @Query('type_id') typeId?: string, @Query('q') q?: string) {
    return this.svc.list({ q: q || undefined, type_id: parseIntQuery(typeId), page: pq.page, limit: pq.limit });
  }

  @Get(':id(\\d+)') getOne(@Param('id', ParseIntPipe) id: number) { return this.svc.getOne(id); }
}

@Controller('vehicle-market')
export class VehicleMarketController {
  constructor(private readonly market: VehicleMarketService) {}

  /** GET /vehicle-market?q=&type_id=&page=&limit= — public shop (enabled vehicles only). */
  @Get()
  list(@Query() pq: PaginationQueryDto, @Query('q') q?: string, @Query('type_id') typeId?: string) {
    return this.market.list(q || undefined, parseIntQuery(typeId), pq.page, pq.limit);
  }

  @Get(':id(\\d+)')
  async getOne(@Param('id', ParseIntPipe) id: number) {
    const v = await this.market.getById(id);
    if (!v) throw new NotFoundException('Vehicle not found');
    return v;
  }
}
