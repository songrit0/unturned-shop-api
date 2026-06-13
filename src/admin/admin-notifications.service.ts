import { Injectable } from '@nestjs/common';
import { DbService } from '../database/db.service';
import { Paginated, normalizePage } from '../common/pagination';

export interface NotifRow {
  id: number;
  title: string;
  body: string;
  accent: string;
  created_at: string;
}

const ACCENTS = ['gold', 'green', 'blue', 'red'];

/**
 * In-game notifications feed (sv_notifications). The GameMenu plugin polls this table and shows
 * each new row as a top-right toast + on the phone lock screen. The plugin also creates the table
 * on load; we CREATE IF NOT EXISTS defensively so the admin form works even before the plugin runs.
 */
@Injectable()
export class AdminNotificationsService {
  constructor(private readonly db: DbService) {}

  private table() {
    return this.db.table('sv', 'notifications');
  }

  private async ensureTable() {
    await this.db.query(
      `CREATE TABLE IF NOT EXISTS ${this.table()} (
         id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
         title VARCHAR(64) NOT NULL,
         body VARCHAR(255) NOT NULL,
         accent VARCHAR(16) NOT NULL DEFAULT 'gold',
         created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
         PRIMARY KEY (id)
       ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
    );
  }

  async list(page?: number, limit?: number): Promise<Paginated<NotifRow>> {
    await this.ensureTable();
    const t = this.table();
    const np = normalizePage(page, limit);
    const cnt = await this.db.first<{ c: number }>(`SELECT COUNT(*) AS c FROM ${t}`);
    const total = cnt ? Number(cnt.c) : 0;
    const items = await this.db.query<NotifRow>(
      `SELECT id, title, body, accent, created_at FROM ${t} ORDER BY id DESC LIMIT ? OFFSET ?`,
      [np.limit, np.offset],
    );
    return { items, total, page: np.page, limit: np.limit, pages: Math.ceil(total / np.limit) };
  }

  async create(title: string, body: string, accent: string): Promise<NotifRow> {
    await this.ensureTable();
    const t = this.table();
    const acc = ACCENTS.includes(accent) ? accent : 'gold';
    const conn = await this.db.getConnection();
    try {
      const [res]: any = await conn.query(
        `INSERT INTO ${t} (title, body, accent) VALUES (?, ?, ?)`,
        [title.slice(0, 64), body.slice(0, 255), acc],
      );
      const [rows]: any = await conn.query(
        `SELECT id, title, body, accent, created_at FROM ${t} WHERE id = ? LIMIT 1`,
        [res.insertId],
      );
      return rows[0];
    } finally {
      conn.release();
    }
  }

  async remove(id: number): Promise<{ ok: boolean }> {
    await this.db.query(`DELETE FROM ${this.table()} WHERE id = ?`, [id]);
    return { ok: true };
  }
}
