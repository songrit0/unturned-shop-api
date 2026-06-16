import { BadRequestException, Injectable } from '@nestjs/common';
import { randomBytes } from 'crypto';
import * as mysql from 'mysql2/promise';
import { DbService } from '../database/db.service';
import { Paginated, normalizePage } from '../common/pagination';

const CODE_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
const CODE_LENGTH = 10;
const CODE_INSERT_RETRIES = 5;
const MERGE_MAX = 50;

export interface CodeItem { item_id: number; kind: number; amount: number; name: string | null; image_url: string | null; }
export interface CodeRow {
  code_id: number;
  code: string;
  max_uses: number;
  uses: number;
  enabled: number;
  expires_at: string | null;
  created_at: string;
  status: 'available' | 'used' | 'expired' | 'disabled';
  items: CodeItem[];
}

export interface MergeResult {
  code: string;
  merged_count: number;
  items: { item_id: number; kind: number; amount: number; name: string | null; image_url: string | null }[];
}

@Injectable()
export class CodesService {
  constructor(private readonly db: DbService) {}

  /** All codes owned by this steam_id, newest first. Items joined per code. */
  async listMine(steamId: string | null, page?: number, limit?: number): Promise<Paginated<CodeRow>> {
    const np = normalizePage(page, limit);
    if (!steamId) return { items: [], total: 0, page: np.page, limit: np.limit, pages: 0 };

    const owners = this.db.table('sv', 'code_owners');
    const codes = this.db.table('rc', 'codes');
    const codeItems = this.db.table('rc', 'code_items');
    const itemsT = this.db.table('sv', 'items');
    const vehiclesT = this.db.table('sv', 'vehicles');

    const cnt = await this.db.first<{ c: number }>(
      `SELECT COUNT(*) AS c FROM ${owners} o INNER JOIN ${codes} c ON c.id = o.code_id WHERE o.steam_id = ?`,
      [steamId],
    );
    const total = cnt ? Number(cnt.c) : 0;

    const rows = await this.db.query<any>(
      `SELECT c.id AS code_id, c.code, c.max_uses, c.uses, c.enabled, c.expires_at, c.created_at
       FROM ${owners} o
       INNER JOIN ${codes} c ON c.id = o.code_id
       WHERE o.steam_id = ?
       ORDER BY c.id DESC
       LIMIT ? OFFSET ?`,
      [steamId, np.limit, np.offset],
    );
    if (rows.length === 0) return { items: [], total, page: np.page, limit: np.limit, pages: Math.ceil(total / np.limit) };

    const codeIds = rows.map(r => r.code_id);
    // kind 0 = item (resolve from sv_items), kind 1 = vehicle (resolve from sv_vehicles).
    const items = await this.db.query<any>(
      `SELECT ci.code_id, ci.item_id, ci.kind, ci.amount,
              COALESCE(v.name, i.name) AS name,
              COALESCE(v.image_url, i.image_url) AS image_url
       FROM ${codeItems} ci
       LEFT JOIN ${itemsT} i ON ci.kind = 0 AND i.id = ci.item_id
       LEFT JOIN ${vehiclesT} v ON ci.kind = 1 AND v.id = ci.item_id
       WHERE ci.code_id IN (${codeIds.map(() => '?').join(',')})`,
      codeIds,
    );

    const byCode = new Map<number, CodeItem[]>();
    for (const it of items) {
      const arr = byCode.get(Number(it.code_id)) || [];
      arr.push({ item_id: Number(it.item_id), kind: Number(it.kind), amount: Number(it.amount), name: it.name, image_url: it.image_url });
      byCode.set(Number(it.code_id), arr);
    }

    const items_out: CodeRow[] = rows.map(r => {
      const codeId = Number(r.code_id);
      const enabled = Number(r.enabled) === 1;
      const exhausted = Number(r.uses) >= Number(r.max_uses);
      const expired = r.expires_at && new Date(r.expires_at) < new Date();
      const status: CodeRow['status'] =
        !enabled ? 'disabled' :
        expired ? 'expired' :
        exhausted ? 'used' : 'available';
      return {
        code_id: codeId,
        code: r.code,
        max_uses: Number(r.max_uses),
        uses: Number(r.uses),
        enabled: Number(r.enabled),
        expires_at: r.expires_at,
        created_at: r.created_at,
        status,
        items: byCode.get(codeId) || [],
      };
    });

    return { items: items_out, total, page: np.page, limit: np.limit, pages: Math.ceil(total / np.limit) };
  }

  /**
   * Merge multiple available codes owned by `steamId` into one new code.
   * Original codes are marked used (uses = max_uses). Items with the same
   * item_id+kind are summed. Atomic — rolls back entirely on any error.
   */
  async merge(steamId: string, codeIds: number[]): Promise<MergeResult> {
    if (codeIds.length < 2) throw new BadRequestException('need_at_least_2_codes');
    if (codeIds.length > MERGE_MAX) throw new BadRequestException('too_many_codes');

    const owners = this.db.table('sv', 'code_owners');
    const codes = this.db.table('rc', 'codes');
    const codeItems = this.db.table('rc', 'code_items');
    const itemsT = this.db.table('sv', 'items');
    const vehiclesT = this.db.table('sv', 'vehicles');

    const conn = await this.db.getConnection();
    try {
      await conn.beginTransaction();

      const ph = codeIds.map(() => '?').join(',');

      // Lock codes that are available, enabled, not expired, and owned by this user.
      const [codeRows] = await conn.query<mysql.RowDataPacket[]>(
        `SELECT c.id, c.max_uses, c.uses, c.enabled, c.expires_at
         FROM ${codes} c
         INNER JOIN ${owners} o ON o.code_id = c.id
         WHERE c.id IN (${ph}) AND o.steam_id = ?
         FOR UPDATE`,
        [...codeIds, steamId],
      );

      const validIds: number[] = [];
      for (const r of codeRows) {
        const enabled = Number(r.enabled) === 1;
        const exhausted = Number(r.uses) >= Number(r.max_uses);
        const expired = r.expires_at && new Date(r.expires_at) < new Date();
        if (enabled && !exhausted && !expired) validIds.push(Number(r.id));
      }

      if (validIds.length < 2) {
        await conn.rollback();
        throw new BadRequestException('not_enough_available_codes');
      }

      // Collect all items from valid codes, summing amounts per item_id+kind.
      const [itemRows] = await conn.query<mysql.RowDataPacket[]>(
        `SELECT item_id, kind, SUM(amount) AS total_amount
         FROM ${codeItems}
         WHERE code_id IN (${validIds.map(() => '?').join(',')})
         GROUP BY item_id, kind`,
        validIds,
      );

      // Mark originals as used.
      await conn.query(
        `UPDATE ${codes} SET uses = max_uses WHERE id IN (${validIds.map(() => '?').join(',')})`,
        validIds,
      );

      // Mint the merged code.
      const newCode = await this.insertNewCode(conn);

      await conn.query(
        `INSERT INTO ${owners} (code_id, steam_id) VALUES (?, ?)`,
        [newCode.codeId, steamId],
      );

      for (const it of itemRows) {
        await conn.query(
          `INSERT INTO ${codeItems} (code_id, item_id, amount, kind) VALUES (?, ?, ?, ?)`,
          [newCode.codeId, Number(it.item_id), Number(it.total_amount), Number(it.kind)],
        );
      }

      await conn.commit();

      // Hydrate item names outside the txn.
      const merged: MergeResult['items'] = [];
      for (const it of itemRows) {
        const itemId = Number(it.item_id);
        const kind = Number(it.kind);
        let name: string | null = null;
        let image_url: string | null = null;
        if (kind === 0) {
          const row = await this.db.first<{ name: string; image_url: string }>(
            `SELECT name, image_url FROM ${itemsT} WHERE id = ?`, [itemId],
          );
          name = row?.name ?? null;
          image_url = row?.image_url ?? null;
        } else {
          const row = await this.db.first<{ name: string; image_url: string }>(
            `SELECT name, image_url FROM ${vehiclesT} WHERE id = ?`, [itemId],
          );
          name = row?.name ?? null;
          image_url = row?.image_url ?? null;
        }
        merged.push({ item_id: itemId, kind, amount: Number(it.total_amount), name, image_url });
      }

      return { code: newCode.code, merged_count: validIds.length, items: merged };
    } catch (e) {
      try { await conn.rollback(); } catch { /* ignore */ }
      throw e;
    } finally {
      conn.release();
    }
  }

  private generateCode(): string {
    const buf = randomBytes(CODE_LENGTH);
    let s = '';
    for (let i = 0; i < CODE_LENGTH; i++) s += CODE_ALPHABET[buf[i] % CODE_ALPHABET.length];
    return s;
  }

  private async insertNewCode(conn: mysql.PoolConnection): Promise<{ code: string; codeId: number }> {
    const codes = this.db.table('rc', 'codes');
    for (let attempt = 0; attempt < CODE_INSERT_RETRIES; attempt++) {
      const code = this.generateCode();
      try {
        const [res] = await conn.query<mysql.ResultSetHeader>(
          `INSERT INTO ${codes} (code, max_uses) VALUES (?, 1)`, [code],
        );
        return { code, codeId: Number(res.insertId) };
      } catch (e: any) {
        if (e?.code === 'ER_DUP_ENTRY') continue;
        throw e;
      }
    }
    throw new Error('code_collision_retry_exhausted');
  }
}
