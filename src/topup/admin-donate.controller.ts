import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  ParseIntPipe,
  Post,
  Put,
  UseGuards,
} from '@nestjs/common';
import {
  IsArray,
  IsBoolean,
  IsInt,
  IsOptional,
  IsString,
} from 'class-validator';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { AdminGuard } from '../common/guards/admin.guard';
import { DonateService } from './donate.service';

class TierDto {
  @IsInt()
  threshold_baht!: number;

  @IsString()
  name!: string;

  @IsOptional()
  @IsBoolean()
  enabled?: boolean;

  @IsOptional()
  @IsInt()
  sort?: number;

  /** Reward set; each entry { kind:'item'|'vehicle'|0|1, item_id, amount?, quality? }. Validated in service. */
  @IsArray()
  rewards!: unknown[];
}

/** Admin CRUD for donation (battlepass) tiers + their reward sets. */
@Controller('admin/donate/tiers')
@UseGuards(JwtAuthGuard, AdminGuard)
export class AdminDonateController {
  constructor(private readonly donate: DonateService) {}

  /** GET /admin/donate/tiers — all tiers (incl. disabled) with rewards. */
  @Get()
  list() {
    return this.donate.adminListTiers();
  }

  /** POST /admin/donate/tiers — create a tier + rewards. */
  @Post()
  create(@Body() body: TierDto) {
    return this.donate.adminCreateTier(body);
  }

  /** PUT /admin/donate/tiers/:id — update fields + replace rewards. */
  @Put(':id')
  update(@Param('id', ParseIntPipe) id: number, @Body() body: TierDto) {
    return this.donate.adminUpdateTier(id, body);
  }

  /** DELETE /admin/donate/tiers/:id — delete the tier + its rewards. */
  @Delete(':id')
  remove(@Param('id', ParseIntPipe) id: number) {
    return this.donate.adminDeleteTier(id);
  }
}
