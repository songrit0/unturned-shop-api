import { Body, Controller, Delete, Get, Param, ParseIntPipe, Post, Put, UseGuards } from '@nestjs/common';
import { IsOptional, IsString, MaxLength } from 'class-validator';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { AdminGuard } from '../common/guards/admin.guard';
import { AdminMarketService } from '../admin/admin-market.service';
import { ItemTypesService } from './item-types.service';

class UpsertItemTypeDto {
  @IsString() @MaxLength(64) name!: string;
  @IsOptional() @IsString() @MaxLength(255) description?: string;
}

class SetMarketTypeDto {
  @IsOptional() type_id?: number | null;
}

@Controller('admin/item-types')
@UseGuards(JwtAuthGuard, AdminGuard)
export class AdminItemTypesController {
  constructor(private readonly svc: ItemTypesService) {}

  @Get() list() { return this.svc.listAll(); }
  @Get(':id') getOne(@Param('id', ParseIntPipe) id: number) { return this.svc.getOne(id); }

  @Post()
  create(@Body() body: UpsertItemTypeDto) {
    return this.svc.create({ name: body.name, description: body.description ?? null });
  }

  @Put(':id')
  update(@Param('id', ParseIntPipe) id: number, @Body() body: UpsertItemTypeDto) {
    return this.svc.update(id, { name: body.name, description: body.description ?? null });
  }

  @Delete(':id') remove(@Param('id', ParseIntPipe) id: number) { return this.svc.remove(id); }
}

@Controller('admin/market')
@UseGuards(JwtAuthGuard, AdminGuard)
export class AdminMarketTypeController {
  constructor(private readonly adminMarket: AdminMarketService) {}

  @Put(':id/type')
  setType(@Param('id', ParseIntPipe) id: number, @Body() body: SetMarketTypeDto) {
    const typeId = body.type_id == null ? null : Number(body.type_id);
    return this.adminMarket.setType(id, typeId);
  }
}
