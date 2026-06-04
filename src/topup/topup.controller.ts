import {
  Body,
  Controller,
  Get,
  Param,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { IsInt } from 'class-validator';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { JwtPayload } from '../auth/strategies/jwt.strategy';
import { PaginationQueryDto } from '../common/dto/pagination-query.dto';
import { TopupService } from './topup.service';

class CreateTopupDto {
  /** Whole baht to charge. Range enforced server-side against TOPUP_MIN/MAX_BAHT. */
  @IsInt()
  baht!: number;
}

@Controller('topup')
@UseGuards(JwtAuthGuard)
export class TopupController {
  constructor(private readonly topup: TopupService) {}

  @Post('create')
  create(@CurrentUser() user: JwtPayload, @Body() body: CreateTopupDto) {
    return this.topup.create(user, body.baht);
  }

  @Get('me')
  history(@CurrentUser() user: JwtPayload, @Query() q: PaginationQueryDto) {
    return this.topup.history(user, q.page, q.limit);
  }

  @Get(':ref')
  getOne(@CurrentUser() user: JwtPayload, @Param('ref') ref: string) {
    return this.topup.getOwned(user, ref);
  }
}

@Controller('vcoins')
@UseGuards(JwtAuthGuard)
export class VcoinsController {
  constructor(private readonly topup: TopupService) {}

  @Get('me')
  me(@CurrentUser() user: JwtPayload) {
    return this.topup.vcoinBalance(user);
  }
}
