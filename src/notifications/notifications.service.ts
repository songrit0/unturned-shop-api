import { Injectable, NotFoundException } from '@nestjs/common';
import { DbService } from '../database/db.service';
import { Paginated, normalizePage } from '../common/pagination';
import { NotificationRow, NotificationView } from './notifications.types';

@Injectable()
export class NotificationsService {
  constructor(private readonly db: DbService) {}

  private tbl() { return this.db.table('sv', 'notifications'); }

  /** `payload` may arrive as a JSON string (mysql2 returns JSON columns as text on some configs). */
  private toView(r: NotificationRow): NotificationView {
    let payload = r.payload;
    if (typeof payload === 'string') {
      try { payload = JSON.parse(payload); } catch { /* leave as-is */ }
    }
    return { id: Number(r.id), kind: r.kind, payload, read_at: r.read_at, created_at: r.created_at };
  }

  /** Page of the caller's notifications, newest first. */
  async listForRecipient(discordId: string | null, page?: number, limit?: number): Promise<Paginated<NotificationView>> {
    const np = normalizePage(page, limit);
    // A steam-only (unlinked) login has no discord recipient -> no notifications.
    if (!discordId) return { items: [], total: 0, page: np.page, limit: np.limit, pages: 0 };
    const cnt = await this.db.first<{ c: number }>(
      `SELECT COUNT(*) AS c FROM ${this.tbl()} WHERE discord_id = ?`, [discordId],
    );
    const total = cnt ? Number(cnt.c) : 0;
    const rows = await this.db.query<NotificationRow>(
      `SELECT id, discord_id, steam_id, kind, payload, dm_status, dm_attempts, dm_sent_at, read_at, created_at
         FROM ${this.tbl()}
        WHERE discord_id = ?
        ORDER BY id DESC
        LIMIT ? OFFSET ?`,
      [discordId, np.limit, np.offset],
    );
    return {
      items: rows.map((r) => this.toView(r)),
      total, page: np.page, limit: np.limit, pages: Math.ceil(total / np.limit),
    };
  }

  /** Count of unread notifications for the caller. */
  async unreadCount(discordId: string | null): Promise<number> {
    if (!discordId) return 0;
    const row = await this.db.first<{ c: number }>(
      `SELECT COUNT(*) AS c FROM ${this.tbl()} WHERE discord_id = ? AND read_at IS NULL`,
      [discordId],
    );
    return row ? Number(row.c) : 0;
  }

  /**
   * Mark one notification read. Scoped to the caller's own rows; a row that doesn't exist
   * or belongs to someone else yields 404 (no information leak about other users' rows).
   * Idempotent: re-marking an already-read row is a no-op success.
   */
  async markRead(id: number, discordId: string | null): Promise<{ ok: true }> {
    if (!discordId) throw new NotFoundException('Notification not found');
    const res: any = await this.db.query(
      `UPDATE ${this.tbl()} SET read_at = COALESCE(read_at, NOW())
        WHERE id = ? AND discord_id = ?`,
      [id, discordId],
    );
    const matched = Number(res?.affectedRows ?? 0);
    if (matched === 0) throw new NotFoundException('Notification not found');
    return { ok: true };
  }
}
