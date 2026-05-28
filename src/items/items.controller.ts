import {
  Body, Controller, Delete, Get, Param, ParseIntPipe, Post, Put, Query, UseGuards,
} from '@nestjs/common';
import { IsInt, IsOptional, IsString, MaxLength, Min } from 'class-validator';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { AdminGuard } from '../common/guards/admin.guard';
import { PaginationQueryDto } from '../common/dto/pagination-query.dto';
import { ItemsService } from './items.service';

class CreateItemDto {
  @IsInt() @Min(1) id!: number;
  @IsString() @MaxLength(64) name!: string;
  @IsOptional() @IsString() @MaxLength(512) description?: string;
  @IsOptional() @IsString() @MaxLength(512) image_url?: string;
  @IsOptional() @IsInt() @Min(1) type_id?: number;
}

class UpdateItemDto {
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

@Controller('admin/items')
@UseGuards(JwtAuthGuard, AdminGuard)
export class AdminItemsController {
  constructor(private readonly svc: ItemsService) {}

  @Get()
  list(@Query() pq: PaginationQueryDto, @Query('q') q?: string, @Query('type_id') typeId?: string) {
    return this.svc.list({ q: q || undefined, type_id: parseIntQuery(typeId), page: pq.page, limit: pq.limit });
  }

  @Get(':id') getOne(@Param('id', ParseIntPipe) id: number) { return this.svc.getOne(id); }

  @Post()
  create(@Body() body: CreateItemDto) {
    return this.svc.create(body.id, {
      name: body.name,
      description: body.description ?? null,
      image_url: body.image_url ?? null,
      type_id: body.type_id ?? null,
    });
  }

  @Put(':id')
  update(@Param('id', ParseIntPipe) id: number, @Body() body: UpdateItemDto) {
    return this.svc.update(id, {
      name: body.name,
      description: body.description ?? null,
      image_url: body.image_url ?? null,
      type_id: body.type_id ?? null,
    });
  }

  @Delete(':id') remove(@Param('id', ParseIntPipe) id: number) { return this.svc.remove(id); }
}

@Controller('items')
export class ItemsController {
  constructor(private readonly svc: ItemsService) {}

  @Get()
  list(@Query() pq: PaginationQueryDto, @Query('type_id') typeId?: string, @Query('q') q?: string) {
    return this.svc.list({ q: q || undefined, type_id: parseIntQuery(typeId), page: pq.page, limit: pq.limit });
  }

  @Get(':id') getOne(@Param('id', ParseIntPipe) id: number) { return this.svc.getOne(id); }
}
