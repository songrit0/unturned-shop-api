import { Body, Controller, Delete, Get, Param, Post, Query, UseGuards } from '@nestjs/common';
import { IsIn, IsOptional, IsString, MaxLength, MinLength } from 'class-validator';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { AdminGuard } from '../common/guards/admin.guard';
import { AdminNotificationsService } from './admin-notifications.service';

class CreateNotifDto {
  @IsString() @MinLength(1) @MaxLength(64) title!: string;
  @IsString() @MinLength(1) @MaxLength(255) body!: string;
  @IsOptional() @IsString() @IsIn(['gold', 'green', 'blue', 'red']) accent?: string;
}

@Controller('admin/notifications')
@UseGuards(JwtAuthGuard, AdminGuard)
export class AdminNotificationsController {
  constructor(private readonly svc: AdminNotificationsService) {}

  @Get()
  list(@Query('page') page?: string, @Query('limit') limit?: string) {
    return this.svc.list(parseInt(page!, 10), parseInt(limit!, 10));
  }

  @Post()
  create(@Body() body: CreateNotifDto) {
    return this.svc.create(body.title, body.body, body.accent || 'gold');
  }

  @Delete(':id')
  remove(@Param('id') id: string) {
    return this.svc.remove(parseInt(id, 10));
  }
}
