import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { DbService } from '../database/db.service';
import { Paginated, normalizePage } from '../common/pagination';

export interface Item {
  id: number;
  name: string;
  description: string | null;
  image_url: string | null;
  type_id: number | null;
  type_name: string | null;
  created_at: Date;
  updated_at: Date;
}

export interface UpsertItemInput {
  name: string;
  description: string | null;
  image_url: string | null;
  type_id: number | null;
}

export interface ItemListFilters {
  q?: string;
  type_id?: number | null;
  page?: number;
  limit?: number;
}

@Injectable()
export class ItemsService {
  constructor(private readonly db: DbService) {}

  async list(filters: ItemListFilters = {}): Promise<Paginated<Item>> {
    const np = normalizePage(filters.page, filters.limit);
    const items = this.db.table('sv', 'items');
    const types = this.db.table('sv', 'item_types');
    const where: string[] = ['1=1'];
    const params: any[] = [];
    if (filters.q) {
      where.push('i.name LIKE ?');
      params.push(`%${filters.q}%`);
    }
    if (filters.type_id != null) {
      where.push('i.type_id = ?');
      params.push(filters.type_id);
    }
    const whereSql = where.join(' AND ');

    const cnt = await this.db.first<{ c: number }>(
      `SELECT COUNT(*) AS c FROM ${items} i WHERE ${whereSql}`,
      params,
    );
    const total = cnt ? Number(cnt.c) : 0;

    const rows = await this.db.query<Item>(
      `SELECT i.id, i.name, i.description, i.image_url, i.type_id, t.name AS type_name,
              i.created_at, i.updated_at
       FROM ${items} i
       LEFT JOIN ${types} t ON t.id = i.type_id
       WHERE ${whereSql}
       ORDER BY i.id ASC
       LIMIT ? OFFSET ?`,
      [...params, np.limit, np.offset],
    );
    return { items: rows, total, page: np.page, limit: np.limit, pages: Math.ceil(total / np.limit) };
  }

  async getOne(id: number): Promise<Item> {
    const items = this.db.table('sv', 'items');
    const types = this.db.table('sv', 'item_types');
    const row = await this.db.first<Item>(
      `SELECT i.id, i.name, i.description, i.image_url, i.type_id, t.name AS type_name,
              i.created_at, i.updated_at
       FROM ${items} i
       LEFT JOIN ${types} t ON t.id = i.type_id
       WHERE i.id = ?`,
      [id],
    );
    if (!row) throw new NotFoundException('Item not found');
    return row;
  }

  async exists(id: number): Promise<boolean> {
    const items = this.db.table('sv', 'items');
    const row = await this.db.first<{ c: number }>(`SELECT COUNT(*) AS c FROM ${items} WHERE id = ?`, [id]);
    return !!row && Number(row.c) > 0;
  }

  async create(id: number, i: UpsertItemInput): Promise<Item> {
    const items = this.db.table('sv', 'items');
    if (await this.exists(id)) {
      throw new ConflictException(`Item ${id} already exists`);
    }
    await this.db.query(
      `INSERT INTO ${items} (id, name, description, image_url, type_id) VALUES (?, ?, ?, ?, ?)`,
      [id, i.name, i.description, i.image_url, i.type_id],
    );
    return this.getOne(id);
  }

  async update(id: number, i: UpsertItemInput): Promise<Item> {
    const items = this.db.table('sv', 'items');
    if (!(await this.exists(id))) throw new NotFoundException('Item not found');
    await this.db.query(
      `UPDATE ${items} SET name = ?, description = ?, image_url = ?, type_id = ? WHERE id = ?`,
      [i.name, i.description, i.image_url, i.type_id, id],
    );
    return this.getOne(id);
  }

  async remove(id: number): Promise<{ ok: true; deleted: number }> {
    const items = this.db.table('sv', 'items');
    const market = this.db.table('sv', 'market');
    const questItems = this.db.table('sv', 'quest_items');

    const mkt = await this.db.first<{ c: number }>(
      `SELECT COUNT(*) AS c FROM ${market} WHERE item_id = ?`, [id],
    );
    if (mkt && Number(mkt.c) > 0) {
      throw new BadRequestException(`Item ${id} is referenced by ${Number(mkt.c)} sv_market row(s)`);
    }
    const qi = await this.db.first<{ c: number }>(
      `SELECT COUNT(*) AS c FROM ${questItems} WHERE item_id = ?`, [id],
    );
    if (qi && Number(qi.c) > 0) {
      throw new BadRequestException(`Item ${id} is referenced by ${Number(qi.c)} sv_quest_items row(s)`);
    }

    const result: any = await this.db.query(`DELETE FROM ${items} WHERE id = ?`, [id]);
    const affected = Array.isArray(result) ? 0 : Number(result?.affectedRows || 0);
    if (affected === 0) throw new NotFoundException('Item not found');
    return { ok: true, deleted: affected };
  }
}
