import { Injectable, NotFoundException } from '@nestjs/common';
import { DbService } from '../database/db.service';
import { Paginated, normalizePage } from '../common/pagination';

export interface ItemType {
  id: number;
  name: string;
  description: string | null;
  created_at: Date;
}

export interface UpsertItemTypeInput {
  name: string;
  description: string | null;
}

@Injectable()
export class ItemTypesService {
  constructor(private readonly db: DbService) {}

  async listAll(page?: number, limit?: number): Promise<Paginated<ItemType>> {
    const np = normalizePage(page, limit);
    const t = this.db.table('sv', 'item_types');

    const cnt = await this.db.first<{ c: number }>(`SELECT COUNT(*) AS c FROM ${t}`);
    const total = cnt ? Number(cnt.c) : 0;

    const items = await this.db.query<ItemType>(
      `SELECT id, name, description, created_at FROM ${t} ORDER BY name ASC LIMIT ? OFFSET ?`,
      [np.limit, np.offset],
    );
    return { items, total, page: np.page, limit: np.limit, pages: Math.ceil(total / np.limit) };
  }

  async getOne(id: number): Promise<ItemType> {
    const t = this.db.table('sv', 'item_types');
    const row = await this.db.first<ItemType>(
      `SELECT id, name, description, created_at FROM ${t} WHERE id = ?`, [id],
    );
    if (!row) throw new NotFoundException('Item type not found');
    return row;
  }

  async create(i: UpsertItemTypeInput): Promise<ItemType> {
    const t = this.db.table('sv', 'item_types');
    const result: any = await this.db.query(
      `INSERT INTO ${t} (name, description) VALUES (?, ?)`,
      [i.name, i.description],
    );
    const insertId = Number(result?.insertId || 0);
    return this.getOne(insertId);
  }

  async update(id: number, i: UpsertItemTypeInput): Promise<ItemType> {
    const t = this.db.table('sv', 'item_types');
    await this.db.query(
      `UPDATE ${t} SET name = ?, description = ? WHERE id = ?`,
      [i.name, i.description, id],
    );
    return this.getOne(id);
  }

  async remove(id: number): Promise<{ ok: true; deleted: number }> {
    const t = this.db.table('sv', 'item_types');
    const market = this.db.table('sv', 'market');
    // null out references first
    await this.db.query(`UPDATE ${market} SET type_id = NULL WHERE type_id = ?`, [id]);
    const result: any = await this.db.query(`DELETE FROM ${t} WHERE id = ?`, [id]);
    const affected = Array.isArray(result) ? 0 : Number(result?.affectedRows || 0);
    return { ok: true, deleted: affected };
  }
}
