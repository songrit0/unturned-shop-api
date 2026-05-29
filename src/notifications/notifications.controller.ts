import { Controller, Get, Param, ParseIntPipe, Post, Query, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { JwtPayload } from '../auth/strategies/jwt.strategy';
import { PaginationQueryDto } from '../common/dto/pagination-query.dto';
import { NotificationsService } from './notifications.service';

@Controller('notifications')
@UseGuards(JwtAuthGuard)
export class NotificationsController {
  constructor(private readonly svc: NotificationsService) {}

  /** GET /notifications/me — the caller's notifications, newest first. Paginated envelope. */
  @Get('me')
  listMine(@CurrentUser() user: JwtPayload, @Query() q: PaginationQueryDto) {
    return this.svc.listForRecipient(user.sub, q.page, q.limit);
  }

  /** GET /notifications/me/unread-count -> { count } */
  @Get('me/unread-count')
  async unreadCount(@CurrentUser() user: JwtPayload): Promise<{ count: number }> {
    return { count: await this.svc.unreadCount(user.sub) };
  }

  /** POST /notifications/:id/read — mark one of the caller's notifications read. */
  @Post(':id(\\d+)/read')
  markRead(@CurrentUser() user: JwtPayload, @Param('id', ParseIntPipe) id: number) {
    return this.svc.markRead(id, user.sub);
  }
}
