import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { DbService } from '../database/db.service';
import { Paginated, normalizePage } from '../common/pagination';

export interface Vehicle {
  id: number;
  name: string;
  description: string | null;
  image_url: string | null;
  type_id: number | null;
  type_name: string | null;
  created_at: Date;
  updated_at: Date;
}

export interface UpsertVehicleInput {
  name: string;
  description: string | null;
  image_url: string | null;
  type_id: number | null;
}

export interface VehicleListFilters {
  q?: string;
  type_id?: number | null;
  page?: number;
  limit?: number;
}

@Injectable()
export class VehiclesService {
  constructor(private readonly db: DbService) {}

  async list(filters: VehicleListFilters = {}): Promise<Paginated<Vehicle>> {
    const np = normalizePage(filters.page, filters.limit);
    const vehicles = this.db.table('sv', 'vehicles');
    const types = this.db.table('sv', 'item_types');
    const where: string[] = ['1=1'];
    const params: any[] = [];
    if (filters.q) {
      where.push('v.name LIKE ?');
      params.push(`%${filters.q}%`);
    }
    if (filters.type_id != null) {
      where.push('v.type_id = ?');
      params.push(filters.type_id);
    }
    const whereSql = where.join(' AND ');

    const cnt = await this.db.first<{ c: number }>(
      `SELECT COUNT(*) AS c FROM ${vehicles} v WHERE ${whereSql}`,
      params,
    );
    const total = cnt ? Number(cnt.c) : 0;

    const rows = await this.db.query<Vehicle>(
      `SELECT v.id, v.name, v.description, v.image_url, v.type_id, t.name AS type_name,
              v.created_at, v.updated_at
       FROM ${vehicles} v
       LEFT JOIN ${types} t ON t.id = v.type_id
       WHERE ${whereSql}
       ORDER BY v.id ASC
       LIMIT ? OFFSET ?`,
      [...params, np.limit, np.offset],
    );
    return { items: rows, total, page: np.page, limit: np.limit, pages: Math.ceil(total / np.limit) };
  }

  async getOne(id: number): Promise<Vehicle> {
    const vehicles = this.db.table('sv', 'vehicles');
    const types = this.db.table('sv', 'item_types');
    const row = await this.db.first<Vehicle>(
      `SELECT v.id, v.name, v.description, v.image_url, v.type_id, t.name AS type_name,
              v.created_at, v.updated_at
       FROM ${vehicles} v
       LEFT JOIN ${types} t ON t.id = v.type_id
       WHERE v.id = ?`,
      [id],
    );
    if (!row) throw new NotFoundException('Vehicle not found');
    return row;
  }

  async exists(id: number): Promise<boolean> {
    const vehicles = this.db.table('sv', 'vehicles');
    const row = await this.db.first<{ c: number }>(`SELECT COUNT(*) AS c FROM ${vehicles} WHERE id = ?`, [id]);
    return !!row && Number(row.c) > 0;
  }

  async create(id: number, v: UpsertVehicleInput): Promise<Vehicle> {
    const vehicles = this.db.table('sv', 'vehicles');
    if (await this.exists(id)) {
      throw new ConflictException(`Vehicle ${id} already exists`);
    }
    await this.db.query(
      `INSERT INTO ${vehicles} (id, name, description, image_url, type_id) VALUES (?, ?, ?, ?, ?)`,
      [id, v.name, v.description, v.image_url, v.type_id],
    );
    return this.getOne(id);
  }

  async update(id: number, v: UpsertVehicleInput): Promise<Vehicle> {
    const vehicles = this.db.table('sv', 'vehicles');
    if (!(await this.exists(id))) throw new NotFoundException('Vehicle not found');
    await this.db.query(
      `UPDATE ${vehicles} SET name = ?, description = ?, image_url = ?, type_id = ? WHERE id = ?`,
      [v.name, v.description, v.image_url, v.type_id, id],
    );
    return this.getOne(id);
  }

  async remove(id: number): Promise<{ ok: true; deleted: number }> {
    const vehicles = this.db.table('sv', 'vehicles');
    const market = this.db.table('sv', 'vehicle_market');

    const mkt = await this.db.first<{ c: number }>(
      `SELECT COUNT(*) AS c FROM ${market} WHERE vehicle_id = ?`, [id],
    );
    if (mkt && Number(mkt.c) > 0) {
      throw new BadRequestException(`Vehicle ${id} is referenced by ${Number(mkt.c)} sv_vehicle_market row(s)`);
    }

    const result: any = await this.db.query(`DELETE FROM ${vehicles} WHERE id = ?`, [id]);
    const affected = Array.isArray(result) ? 0 : Number(result?.affectedRows || 0);
    if (affected === 0) throw new NotFoundException('Vehicle not found');
    return { ok: true, deleted: affected };
  }
}
