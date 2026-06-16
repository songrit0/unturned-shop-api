import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { DbService } from '../database/db.service';

export interface HelpTopic {
  id: number;
  title: string;
  body: string;
  category: string | null;
  icon: string | null;
  sort_order: number;
  enabled: boolean;
  updated_at?: string;
}

export interface HelpInput {
  title: string;
  body: string;
  category?: string | null;
  icon?: string | null;
  sort_order?: number;
  enabled?: boolean;
}

/**
 * HELP topics — the in-game command guide. Admins manage them from the web; the GameMenu phone reads
 * sv_help_topics directly from MySQL (not via this API) and renders each as a popup page.
 */
@Injectable()
export class HelpService {
  constructor(private readonly db: DbService) {}

  private table() { return this.db.table('sv', 'help_topics'); }

  private map(r: any): HelpTopic {
    return {
      id: Number(r.id),
      title: r.title ?? '',
      body: r.body ?? '',
      category: r.category ?? null,
      icon: r.icon ?? null,
      sort_order: Number(r.sort_order ?? 0),
      enabled: Number(r.enabled) === 1,
      updated_at: r.updated_at,
    };
  }

  /** Public: enabled topics, ordered (for the website + previews). */
  async listPublic(): Promise<HelpTopic[]> {
    const rows = await this.db.query<any>(
      `SELECT id, title, body, category, icon, sort_order, enabled FROM ${this.table()}
       WHERE enabled = 1 ORDER BY sort_order ASC, id ASC`,
    );
    return rows.map((r) => this.map(r));
  }

  async getPublic(id: number): Promise<HelpTopic> {
    const r = await this.db.first<any>(
      `SELECT id, title, body, category, icon, sort_order, enabled FROM ${this.table()} WHERE id = ? AND enabled = 1`,
      [id],
    );
    if (!r) throw new NotFoundException('help_not_found');
    return this.map(r);
  }

  // ---- admin ----------------------------------------------------------------
  async listAll(): Promise<HelpTopic[]> {
    const rows = await this.db.query<any>(
      `SELECT id, title, body, category, icon, sort_order, enabled, updated_at FROM ${this.table()}
       ORDER BY sort_order ASC, id ASC`,
    );
    return rows.map((r) => this.map(r));
  }

  async create(input: HelpInput): Promise<HelpTopic> {
    const v = this.validate(input);
    const res: any = await this.db.query(
      `INSERT INTO ${this.table()} (title, body, category, icon, sort_order, enabled)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [v.title, v.body, v.category, v.icon, v.sort_order, v.enabled ? 1 : 0],
    );
    return this.adminGet(Number(res?.insertId || 0));
  }

  async update(id: number, input: HelpInput): Promise<HelpTopic> {
    await this.adminGet(id); // 404 if missing
    const v = this.validate(input);
    await this.db.query(
      `UPDATE ${this.table()} SET title = ?, body = ?, category = ?, icon = ?, sort_order = ?, enabled = ?
       WHERE id = ?`,
      [v.title, v.body, v.category, v.icon, v.sort_order, v.enabled ? 1 : 0, id],
    );
    return this.adminGet(id);
  }

  async remove(id: number): Promise<{ ok: true }> {
    await this.db.query(`DELETE FROM ${this.table()} WHERE id = ?`, [id]);
    return { ok: true };
  }

  private async adminGet(id: number): Promise<HelpTopic> {
    const r = await this.db.first<any>(
      `SELECT id, title, body, category, icon, sort_order, enabled, updated_at FROM ${this.table()} WHERE id = ?`,
      [id],
    );
    if (!r) throw new NotFoundException('help_not_found');
    return this.map(r);
  }

  private validate(input: HelpInput): Required<HelpInput> {
    const title = (input.title ?? '').trim();
    const body = (input.body ?? '').trim();
    if (!title) throw new BadRequestException('title_required');
    if (!body) throw new BadRequestException('body_required');
    return {
      title: title.slice(0, 128),
      body,
      category: (input.category ?? '').trim().slice(0, 64) || null,
      icon: (input.icon ?? '').trim().slice(0, 8) || null,
      sort_order: Number.isFinite(Number(input.sort_order)) ? Math.trunc(Number(input.sort_order)) : 0,
      enabled: input.enabled === undefined ? true : !!input.enabled,
    };
  }
}
