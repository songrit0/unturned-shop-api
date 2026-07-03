import { Injectable } from '@nestjs/common';
import { DbService } from '../database/db.service';
import { Paginated, normalizePage } from '../common/pagination';

/** แถวจากตาราง sv_kills (เขียนโดยปลั๊กอิน KillFeed) + รูปอาวุธจาก sv_items */
export interface KillRow {
  id: number;
  is_pvp: number;
  cause: string;
  killer_steam_id: string | null;
  killer_name: string | null;
  victim_steam_id: string;
  victim_name: string;
  weapon: string | null;
  weapon_id: number | null;
  distance: number | null;
  headshot: number;
  killer_x: number | null;
  killer_y: number | null;
  killer_z: number | null;
  victim_x: number;
  victim_y: number;
  victim_z: number;
  created_at: string;
  weapon_image: string | null;
}

export interface ListKillsOptions {
  /** จำกัดเฉพาะ kill ที่ steam id นี้เป็น killer หรือ victim (ผู้เล่นปกติ / admin filter) */
  steamId?: string;
  /** ซ่อน kill ที่ใหม่กว่า X นาที (ผู้เล่นปกติ = 30, admin = 0) */
  delayMinutes: number;
  /** จากวันที่ (YYYY-MM-DD, รวมวันนั้น) */
  from?: string;
  /** ถึงวันที่ (YYYY-MM-DD, รวมวันนั้น) */
  to?: string;
  page?: number;
  limit?: number;
}

@Injectable()
export class KillsService {
  constructor(private readonly db: DbService) {}

  async list(opts: ListKillsOptions): Promise<Paginated<KillRow>> {
    const kills = this.db.table('sv', 'kills');
    const items = this.db.table('sv', 'items');
    const np = normalizePage(opts.page, opts.limit);

    const where: string[] = ['1=1'];
    const params: unknown[] = [];
    if (opts.steamId) {
      where.push('(k.killer_steam_id = ? OR k.victim_steam_id = ?)');
      params.push(opts.steamId, opts.steamId);
    }
    if (opts.delayMinutes > 0) {
      where.push('k.created_at <= NOW() - INTERVAL ? MINUTE');
      params.push(opts.delayMinutes);
    }
    if (opts.from) {
      where.push('k.created_at >= ?');
      params.push(opts.from);
    }
    if (opts.to) {
      where.push('k.created_at < DATE_ADD(?, INTERVAL 1 DAY)');
      params.push(opts.to);
    }
    const cond = where.join(' AND ');

    const totalRow = await this.db.first<{ total: number }>(
      `SELECT COUNT(*) AS total FROM ${kills} k WHERE ${cond}`,
      params,
    );
    const rows = await this.db.query<KillRow>(
      `SELECT k.id, k.is_pvp, k.cause,
              k.killer_steam_id, k.killer_name, k.victim_steam_id, k.victim_name,
              k.weapon, k.weapon_id, k.distance, k.headshot,
              k.killer_x, k.killer_y, k.killer_z, k.victim_x, k.victim_y, k.victim_z,
              k.created_at, i.image_url AS weapon_image
       FROM ${kills} k
       LEFT JOIN ${items} i ON i.id = k.weapon_id
       WHERE ${cond}
       ORDER BY k.id DESC
       LIMIT ? OFFSET ?`,
      [...params, np.limit, np.offset],
    );

    const total = Number(totalRow?.total ?? 0);
    return {
      items: rows,
      total,
      page: np.page,
      limit: np.limit,
      pages: Math.max(1, Math.ceil(total / np.limit)),
    };
  }
}
