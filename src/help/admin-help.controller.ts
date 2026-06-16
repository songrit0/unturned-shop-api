import { Body, Controller, Delete, Get, Param, Post, Put, UseGuards } from '@nestjs/common';
import { IsBoolean, IsInt, IsOptional, IsString, MaxLength, MinLength } from 'class-validator';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { AdminGuard } from '../common/guards/admin.guard';
import { HelpService } from './help.service';

class HelpDto {
  @IsString() @MinLength(1) @MaxLength(128) title!: string;
  @IsString() @MinLength(1) body!: string;
  @IsOptional() @IsString() @MaxLength(64) category?: string;
  @IsOptional() @IsString() @MaxLength(8) icon?: string;
  @IsOptional() @IsInt() sort_order?: number;
  @IsOptional() @IsBoolean() enabled?: boolean;
}

/** Admin CRUD for in-game help topics. */
@Controller('admin/help')
@UseGuards(JwtAuthGuard, AdminGuard)
export class AdminHelpController {
  constructor(private readonly help: HelpService) {}

  @Get()
  list() {
    return this.help.listAll();
  }

  @Post()
  create(@Body() body: HelpDto) {
    return this.help.create(body);
  }

  @Put(':id')
  update(@Param('id') id: string, @Body() body: HelpDto) {
    return this.help.update(parseInt(id, 10), body);
  }

  @Delete(':id')
  remove(@Param('id') id: string) {
    return this.help.remove(parseInt(id, 10));
  }
}
