import { Controller, ForbiddenException, Get, Query, UseGuards } from '@nestjs/common';
import { IsIn, IsOptional, IsString, Matches } from 'class-validator';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { JwtPayload } from '../auth/strategies/jwt.strategy';
import { PaginationQueryDto } from '../common/dto/pagination-query.dto';
import { KillsService } from './kills.service';

/** ผู้เล่นปกติเห็น kill ของตัวเองแบบดีเลย์ 30 นาที (กันเอาไปส่องตำแหน่งสด) */
const PLAYER_DELAY_MINUTES = 30;

class KillsQueryDto extends PaginationQueryDto {
  @IsOptional() @Matches(/^\d{4}-\d{2}-\d{2}$/) from?: string;
  @IsOptional() @Matches(/^\d{4}-\d{2}-\d{2}$/) to?: string;
  /** admin เท่านั้น: กรองเฉพาะผู้เล่นคนเดียว */
  @IsOptional() @IsString() @Matches(/^\d{17}$/) steam_id?: string;
  /** กรองประเภท: '1' = PvP, '0' = PvE */
  @IsOptional() @IsIn(['0', '1']) is_pvp?: string;
}

@Controller('kills')
@UseGuards(JwtAuthGuard)
export class KillsController {
  constructor(private readonly svc: KillsService) {}

  @Get()
  list(@CurrentUser() user: JwtPayload, @Query() q: KillsQueryDto) {
    const isPvp = q.is_pvp == null ? undefined : q.is_pvp === '1';
    if (user.is_admin) {
      return this.svc.list({
        steamId: q.steam_id,
        delayMinutes: 0,
        isPvp,
        from: q.from,
        to: q.to,
        page: q.page,
        limit: q.limit,
      });
    }

    if (!user.steam_id) {
      throw new ForbiddenException('ยังไม่ได้ผูก Steam ID — ใช้คำสั่ง /link ใน Discord ก่อน');
    }
    return this.svc.list({
      steamId: user.steam_id,
      delayMinutes: PLAYER_DELAY_MINUTES,
      isPvp,
      from: q.from,
      to: q.to,
      page: q.page,
      limit: q.limit,
    });
  }
}
