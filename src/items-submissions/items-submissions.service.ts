import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import * as mysql from 'mysql2/promise';
import { DbService } from '../database/db.service';
import { Paginated, normalizePage } from '../common/pagination';
import {
  CurrentItemSnapshot,
  ItemSubmission,
  SubmissionPatch,
  SubmissionStatus,
} from './items-submissions.types';

interface SubmissionRowRaw {
  id: number;
  item_id: number;
  submitter_steam: string;
  submitter_discord_name: string | null;
  name: string | null;
  description: string | null;
  image_url: string | null;
  type_id: number | null;
  status: SubmissionStatus;
  admin_note: string | null;
  reviewed_by: string | null;
  reviewer_discord_name: string | null;
  reviewed_at: Date | null;
  submitted_at: Date;
  current_name: string | null;
  current_description: string | null;
  current_image_url: string | null;
  current_type_id: number | null;
  current_type_name: string | null;
  current_item_id_present: number | null;
}

@Injectable()
export class ItemsSubmissionsService {
  constructor(private readonly db: DbService) {}

  private subsTbl()   { return this.db.table('sv', 'item_submissions'); }
  private linksTbl()  { return this.db.table('sv', 'links'); }
  private itemsTbl()  { return this.db.table('sv', 'items'); }
  private typesTbl()  { return this.db.table('sv', 'item_types'); }

  private rowToSubmission(r: SubmissionRowRaw): ItemSubmission {
    const currentPresent = r.current_item_id_present != null;
    const current: CurrentItemSnapshot | null = currentPresent
      ? {
          name: r.current_name,
          description: r.current_description,
          image_url: r.current_image_url,
          type_id: r.current_type_id,
          type_name: r.current_type_name,
        }
      : null;
    return {
      id: Number(r.id),
      item_id: Number(r.item_id),
      submitter_steam: String(r.submitter_steam),
      submitter_discord_name: r.submitter_discord_name,
      name: r.name,
      description: r.description,
      image_url: r.image_url,
      type_id: r.type_id,
      status: r.status,
      admin_note: r.admin_note,
      reviewed_by: r.reviewed_by,
      reviewer_discord_name: r.reviewer_discord_name,
      reviewed_at: r.reviewed_at,
      submitted_at: r.submitted_at,
      current_item: current,
    };
  }

  private selectSql(extraWhere: string): string {
    return `SELECT s.id, s.item_id, s.submitter_steam,
                   COALESCE(ls.discord_username, ls.discord_global_name, ls.discord_id) AS submitter_discord_name,
                   s.name, s.description, s.image_url, s.type_id, s.status,
                   s.admin_note, s.reviewed_by,
                   COALESCE(lr.discord_username, lr.discord_global_name, lr.discord_id) AS reviewer_discord_name,
                   s.reviewed_at, s.submitted_at,
                   i.id   AS current_item_id_present,
                   i.name AS current_name,
                   i.description AS current_description,
                   i.image_url AS current_image_url,
                   i.type_id AS current_type_id,
                   t.name AS current_type_name
            FROM ${this.subsTbl()} s
            LEFT JOIN ${this.linksTbl()} ls ON ls.steam_id = s.submitter_steam
            LEFT JOIN ${this.linksTbl()} lr ON lr.steam_id = s.reviewed_by
            LEFT JOIN ${this.itemsTbl()} i  ON i.id = s.item_id
            LEFT JOIN ${this.typesTbl()} t  ON t.id = i.type_id
            ${extraWhere}`;
  }

  async create(itemId: number, submitterSteam: string, patch: SubmissionPatch): Promise<ItemSubmission> {
    const hasAny =
      (patch.name !== undefined && patch.name !== null && patch.name !== '') ||
      (patch.description !== undefined && patch.description !== null && patch.description !== '') ||
      (patch.image_url !== undefined && patch.image_url !== null && patch.image_url !== '') ||
      (patch.type_id !== undefined && patch.type_id !== null);
    if (!hasAny) throw new BadRequestException('nothing_to_submit');

    if (!Number.isInteger(itemId) || itemId < 1 || itemId > 65535) {
      throw new BadRequestException('invalid_item_id');
    }

    // sv_items acts as the master ledger of known item IDs. If this is the first
    // time anyone has referenced this ID, create a blank row so admin approve can
    // later fill it in via COALESCE. Wrapped with the submission INSERT so a
    // duplicate submitter doesn't leave a stray sv_items row behind.
    const conn = await this.db.getConnection();
    let newId = 0;
    try {
      await conn.beginTransaction();
      await conn.query(`INSERT IGNORE INTO ${this.itemsTbl()} (id) VALUES (?)`, [itemId]);
      try {
        const [res] = await conn.query<any>(
          `INSERT INTO ${this.subsTbl()}
             (item_id, submitter_steam, name, description, image_url, type_id, status)
           VALUES (?, ?, ?, ?, ?, ?, 'pending')`,
          [
            itemId,
            submitterSteam,
            patch.name ?? null,
            patch.description ?? null,
            patch.image_url ?? null,
            patch.type_id ?? null,
          ],
        );
        newId = Number((res as any)?.insertId ?? 0);
      } catch (e: any) {
        if (e?.code === 'ER_DUP_ENTRY') {
          await conn.rollback();
          throw new ConflictException('already_submitted');
        }
        throw e;
      }
      await conn.commit();
    } catch (e) {
      try { await conn.rollback(); } catch { /* ignore */ }
      throw e;
    } finally {
      conn.release();
    }
    return this.getById(newId);
  }

  async getById(id: number): Promise<ItemSubmission> {
    const row = await this.db.first<SubmissionRowRaw>(this.selectSql(`WHERE s.id = ?`), [id]);
    if (!row) throw new NotFoundException('Submission not found');
    return this.rowToSubmission(row);
  }

  async listMine(submitterSteam: string, page?: number, limit?: number): Promise<Paginated<ItemSubmission>> {
    const np = normalizePage(page, limit);
    const cnt = await this.db.first<{ c: number }>(
      `SELECT COUNT(*) AS c FROM ${this.subsTbl()} WHERE submitter_steam = ?`, [submitterSteam],
    );
    const total = cnt ? Number(cnt.c) : 0;
    const rows = await this.db.query<SubmissionRowRaw>(
      this.selectSql(`WHERE s.submitter_steam = ? ORDER BY s.submitted_at DESC LIMIT ? OFFSET ?`),
      [submitterSteam, np.limit, np.offset],
    );
    return { items: rows.map(r => this.rowToSubmission(r)), total, page: np.page, limit: np.limit, pages: Math.ceil(total / np.limit) };
  }

  async listAdmin(filters: { status?: SubmissionStatus; item_id?: number; page?: number; limit?: number }): Promise<Paginated<ItemSubmission>> {
    const np = normalizePage(filters.page, filters.limit);
    const status: SubmissionStatus = filters.status ?? 'pending';
    const where: string[] = ['s.status = ?'];
    const params: any[] = [status];
    if (filters.item_id != null) { where.push('s.item_id = ?'); params.push(filters.item_id); }
    const whereSql = where.join(' AND ');

    const cnt = await this.db.first<{ c: number }>(
      `SELECT COUNT(*) AS c FROM ${this.subsTbl()} s WHERE ${whereSql}`, params,
    );
    const total = cnt ? Number(cnt.c) : 0;
    const rows = await this.db.query<SubmissionRowRaw>(
      this.selectSql(`WHERE ${whereSql} ORDER BY s.submitted_at ASC LIMIT ? OFFSET ?`),
      [...params, np.limit, np.offset],
    );
    return { items: rows.map(r => this.rowToSubmission(r)), total, page: np.page, limit: np.limit, pages: Math.ceil(total / np.limit) };
  }

  async approve(id: number, adminSteam: string): Promise<ItemSubmission> {
    const conn = await this.db.getConnection();
    try {
      await conn.beginTransaction();
      const [rows] = await conn.query<mysql.RowDataPacket[]>(
        `SELECT * FROM ${this.subsTbl()} WHERE id = ? FOR UPDATE`, [id],
      );
      const s = rows[0] as (SubmissionRowRaw & { item_id: number; status: SubmissionStatus }) | undefined;
      if (!s) { await conn.rollback(); throw new NotFoundException('Submission not found'); }
      if (s.status !== 'pending') {
        await conn.rollback();
        throw new ConflictException('submission_not_pending');
      }

      // COALESCE per field — null/empty in submission means "leave as is".
      await conn.query(
        `UPDATE ${this.itemsTbl()} SET
           name        = COALESCE(?, name),
           description = COALESCE(?, description),
           image_url   = COALESCE(?, image_url),
           type_id     = COALESCE(?, type_id)
         WHERE id = ?`,
        [
          s.name && s.name.length ? s.name : null,
          s.description && s.description.length ? s.description : null,
          s.image_url && s.image_url.length ? s.image_url : null,
          s.type_id ?? null,
          s.item_id,
        ],
      );

      await conn.query(
        `UPDATE ${this.subsTbl()} SET status='approved', reviewed_by=?, reviewed_at=NOW() WHERE id = ?`,
        [adminSteam, id],
      );
      await conn.commit();
    } catch (e) {
      try { await conn.rollback(); } catch { /* ignore */ }
      throw e;
    } finally {
      conn.release();
    }
    return this.getById(id);
  }

  async reject(id: number, adminSteam: string, adminNote: string | null): Promise<ItemSubmission> {
    const conn = await this.db.getConnection();
    try {
      await conn.beginTransaction();
      const [rows] = await conn.query<mysql.RowDataPacket[]>(
        `SELECT status FROM ${this.subsTbl()} WHERE id = ? FOR UPDATE`, [id],
      );
      const r = rows[0] as { status: SubmissionStatus } | undefined;
      if (!r) { await conn.rollback(); throw new NotFoundException('Submission not found'); }
      if (r.status !== 'pending') {
        await conn.rollback();
        throw new ConflictException('submission_not_pending');
      }
      await conn.query(
        `UPDATE ${this.subsTbl()} SET status='rejected', admin_note=?, reviewed_by=?, reviewed_at=NOW() WHERE id = ?`,
        [adminNote, adminSteam, id],
      );
      await conn.commit();
    } catch (e) {
      try { await conn.rollback(); } catch { /* ignore */ }
      throw e;
    } finally {
      conn.release();
    }
    return this.getById(id);
  }
}
