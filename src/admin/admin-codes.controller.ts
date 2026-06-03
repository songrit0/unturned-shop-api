import { Body, Controller, Delete, Get, Param, ParseIntPipe, Post, Put, Query, UseGuards } from '@nestjs/common';
import { IsBoolean, IsOptional, IsString } from 'class-validator';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { AdminGuard } from '../common/guards/admin.guard';
import { PaginationQueryDto } from '../common/dto/pagination-query.dto';
import { AdminCodesService, CreateCodeInput } from './admin-codes.service';

class ToggleEnabledDto { @IsBoolean() enabled!: boolean; }

// whitelist:true strips undecorated props, so `q` needs a decorated field to survive.
class ListCodesQueryDto extends PaginationQueryDto {
  @IsOptional() @IsString() q?: string;
}

@Controller('admin/codes')
@UseGuards(JwtAuthGuard, AdminGuard)
export class AdminCodesController {
  constructor(private readonly svc: AdminCodesService) {}

  /** GET /admin/codes — all codes (every owner), newest first. Optional `q` filters by code. Paginated. */
  @Get()
  list(@Query() q: ListCodesQueryDto) {
    return this.svc.listAll(q.q, q.page, q.limit);
  }

  /** POST /admin/codes — create a public/unowned redeem code. Body validated in the service. */
  @Post()
  create(@Body() body: CreateCodeInput) {
    return this.svc.create(body);
  }

  /** PUT /admin/codes/:id/enabled — enable/disable a code. */
  @Put(':id/enabled')
  setEnabled(@Param('id', ParseIntPipe) id: number, @Body() body: ToggleEnabledDto) {
    return this.svc.setEnabled(id, body.enabled);
  }

  /** DELETE /admin/codes/:id — delete a code and its items/ownership. */
  @Delete(':id')
  remove(@Param('id', ParseIntPipe) id: number) {
    return this.svc.remove(id);
  }
}
