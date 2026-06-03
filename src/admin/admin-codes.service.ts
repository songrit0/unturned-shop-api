import { BadRequestException, ConflictException, Injectable } from '@nestjs/common';
import { randomBytes } from 'crypto';
import { DbService } from '../database/db.service';
import { Paginated, normalizePage } from '../common/pagination';

const CODE_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';

export type RewardKind = 'item' | 'vehicle';

export interface AdminCodeItem { item_id: number; kind: number; amount: number; name: string | null; image_url: string | null; }
export interface AdminCodeRow {
  code_id: number;
  code: string;
  max_uses: number;
  uses: number;
  enabled: number;
  expires_at: string | null;
  created_at: string;
  status: 'available' | 'used' | 'expired' | 'disabled';
  items: AdminCodeItem[];
}

export interface CreateCodeReward { kind: RewardKind; id: number; amount: number; quality?: number; }
export interface CreateCodeInput {
  code?: string;
  max_uses: number;
  expires_at?: string | null;
  enabled?: boolean;
  rewards: CreateCodeReward[];
}

/** Compute the display status for a code row (mirrors codes.service.ts). */
function computeStatus(r: { enabled: number; uses: number; max_uses: number; expires_at: string | null }): AdminCodeRow['status'] {
  const enabled = Number(r.enabled) === 1;
  // max_uses 0 = unlimited total, so it can never be exhausted.
  const exhausted = Number(r.max_uses) > 0 && Number(r.uses) >= Number(r.max_uses);
  const expired = !!r.expires_at && new Date(r.expires_at) < new Date();
  return !enabled ? 'disabled' : expired ? 'expired' : exhausted ? 'used' : 'available';
}

@Injectable()
export class AdminCodesService {
  constructor(private readonly db: DbService) {}

  private genCode(n = 10): string {
    const buf = randomBytes(n);
    let s = '';
    for (let i = 0; i < n; i++) s += CODE_ALPHABET[buf[i] % CODE_ALPHABET.length];
    return s;
  }

  /** Create an admin (public/unowned) redeem code with its reward items. Returns the created row. */
  async create(input: CreateCodeInput): Promise<AdminCodeRow> {
    // --- validate top-level fields ---
    const maxUses = Number(input.max_uses);
    if (!Number.isInteger(maxUses) || maxUses < 0) {
      throw new BadRequestException('max_uses must be an integer >= 0 (0 = unlimited)');
    }

    let expiresAt: string | null = null;
    if (input.expires_at !== undefined && input.expires_at !== null && String(input.expires_at).trim() !== '') {
      const d = new Date(input.expires_at);
      if (isNaN(d.getTime())) throw new BadRequestException('expires_at must be a valid ISO date string or null');
      expiresAt = input.expires_at;
    }

    const enabled = input.enabled !== false; // default true

    // --- validate rewards ---
    if (!Array.isArray(input.rewards) || input.rewards.length === 0) {
      throw new BadRequestException('rewards must be a non-empty array');
    }
    const rewards = input.rewards.map((rw, idx) => {
      if (rw.kind !== 'item' && rw.kind !== 'vehicle') {
        throw new BadRequestException(`rewards[${idx}].kind must be 'item' or 'vehicle'`);
      }
      const id = Number(rw.id);
      if (!Number.isInteger(id) || id < 1) {
        throw new BadRequestException(`rewards[${idx}].id must be a positive integer`);
      }
      const amount = Number(rw.amount);
      if (!Number.isInteger(amount) || amount < 1) {
        throw new BadRequestException(`rewards[${idx}].amount must be an integer >= 1`);
      }
      // quality optional, clamp 0..100, default 100 (meaningful for items; harmless for vehicles).
      let quality = rw.quality === undefined || rw.quality === null ? 100 : Number(rw.quality);
      if (!Number.isFinite(quality)) quality = 100;
      quality = Math.max(0, Math.min(100, Math.round(quality)));
      return { kind: rw.kind, id, amount, quality };
    });

    // --- validate referenced ids exist in their catalogs ---
    const itemsT = this.db.table('sv', 'items');
    const vehiclesT = this.db.table('sv', 'vehicles');
    const itemIds = [...new Set(rewards.filter(r => r.kind === 'item').map(r => r.id))];
    const vehicleIds = [...new Set(rewards.filter(r => r.kind === 'vehicle').map(r => r.id))];

    const missing: string[] = [];
    if (itemIds.length > 0) {
      const found = await this.db.query<{ id: number }>(
        `SELECT id FROM ${itemsT} WHERE id IN (${itemIds.map(() => '?').join(',')})`,
        itemIds,
      );
      const have = new Set(found.map(f => Number(f.id)));
      for (const id of itemIds) if (!have.has(id)) missing.push(`item ${id}`);
    }
    if (vehicleIds.length > 0) {
      const found = await this.db.query<{ id: number }>(
        `SELECT id FROM ${vehiclesT} WHERE id IN (${vehicleIds.map(() => '?').join(',')})`,
        vehicleIds,
      );
      const have = new Set(found.map(f => Number(f.id)));
      for (const id of vehicleIds) if (!have.has(id)) missing.push(`vehicle ${id}`);
    }
    if (missing.length > 0) {
      throw new BadRequestException(`Unknown reward ids: ${missing.join(', ')}`);
    }

    // --- resolve / validate the code string ---
    const codesT = this.db.table('rc', 'codes');
    const codeItemsT = this.db.table('rc', 'code_items');
    const customCode = typeof input.code === 'string' ? input.code.trim() : '';

    if (customCode) {
      const taken = await this.db.first<{ c: number }>(
        `SELECT COUNT(*) AS c FROM ${codesT} WHERE code = ?`, [customCode],
      );
      if (taken && Number(taken.c) > 0) {
        throw new ConflictException(`Code "${customCode}" is already taken`);
      }
    }

    const conn = await this.db.getConnection();
    try {
      await conn.beginTransaction();

      // Insert the code row, generating + retrying on collision when no custom code was given.
      let codeStr = customCode;
      let codeId: number;
      if (customCode) {
        const [ins] = await conn.query(
          `INSERT INTO ${codesT} (code, max_uses, enabled, expires_at) VALUES (?, ?, ?, ?)`,
          [customCode, maxUses, enabled ? 1 : 0, expiresAt],
        );
        codeId = (ins as any).insertId;
      } else {
        let inserted = false;
        let attempt = 0;
        codeId = 0;
        while (!inserted) {
          codeStr = this.genCode(10);
          try {
            const [ins] = await conn.query(
              `INSERT INTO ${codesT} (code, max_uses, enabled, expires_at) VALUES (?, ?, ?, ?)`,
              [codeStr, maxUses, enabled ? 1 : 0, expiresAt],
            );
            codeId = (ins as any).insertId;
            inserted = true;
          } catch (e: any) {
            if (e?.code === 'ER_DUP_ENTRY' && attempt < 5) { attempt++; continue; }
            throw e;
          }
        }
      }

      // Insert reward items. kind: 0=item, 1=vehicle.
      for (const rw of rewards) {
        await conn.query(
          `INSERT INTO ${codeItemsT} (code_id, item_id, amount, quality, state, rot, kind) VALUES (?, ?, ?, ?, ?, ?, ?)`,
          [codeId, rw.id, rw.amount, rw.quality, '', 0, rw.kind === 'vehicle' ? 1 : 0],
        );
      }

      await conn.commit();
      return this.getOne(codeId);
    } catch (e) {
      try { await conn.rollback(); } catch {}
      throw e;
    } finally {
      conn.release();
    }
  }

  /** All codes (every owner), newest first, with reward items resolved. Optional `q` filters by code LIKE. */
  async listAll(q?: string, page?: number, limit?: number): Promise<Paginated<AdminCodeRow>> {
    const np = normalizePage(page, limit);
    const codes = this.db.table('rc', 'codes');

    const term = typeof q === 'string' ? q.trim() : '';
    const where = term ? `WHERE c.code LIKE ?` : '';
    const whereParams: any[] = term ? [`%${term}%`] : [];

    const cnt = await this.db.first<{ c: number }>(
      `SELECT COUNT(*) AS c FROM ${codes} c ${where}`, whereParams,
    );
    const total = cnt ? Number(cnt.c) : 0;

    const rows = await this.db.query<any>(
      `SELECT c.id AS code_id, c.code, c.max_uses, c.uses, c.enabled, c.expires_at, c.created_at
       FROM ${codes} c
       ${where}
       ORDER BY c.id DESC
       LIMIT ? OFFSET ?`,
      [...whereParams, np.limit, np.offset],
    );
    if (rows.length === 0) return { items: [], total, page: np.page, limit: np.limit, pages: Math.ceil(total / np.limit) };

    const itemsByCode = await this.itemsForCodes(rows.map(r => Number(r.code_id)));
    const items = rows.map(r => this.toRow(r, itemsByCode.get(Number(r.code_id)) || []));

    return { items, total, page: np.page, limit: np.limit, pages: Math.ceil(total / np.limit) };
  }

  /** Fetch a single code as a list-shaped row. */
  async getOne(codeId: number): Promise<AdminCodeRow> {
    const codes = this.db.table('rc', 'codes');
    const row = await this.db.first<any>(
      `SELECT c.id AS code_id, c.code, c.max_uses, c.uses, c.enabled, c.expires_at, c.created_at
       FROM ${codes} c WHERE c.id = ?`,
      [codeId],
    );
    if (!row) throw new BadRequestException('Code not found');
    const itemsByCode = await this.itemsForCodes([codeId]);
    return this.toRow(row, itemsByCode.get(codeId) || []);
  }

  async setEnabled(codeId: number, enabled: boolean): Promise<{ ok: true }> {
    const codes = this.db.table('rc', 'codes');
    await this.db.query(`UPDATE ${codes} SET enabled = ? WHERE id = ?`, [enabled ? 1 : 0, codeId]);
    return { ok: true };
  }

  async remove(codeId: number): Promise<{ ok: true }> {
    const codeItems = this.db.table('rc', 'code_items');
    const owners = this.db.table('sv', 'code_owners');
    const codes = this.db.table('rc', 'codes');

    const conn = await this.db.getConnection();
    try {
      await conn.beginTransaction();
      await conn.query(`DELETE FROM ${codeItems} WHERE code_id = ?`, [codeId]);
      await conn.query(`DELETE FROM ${owners} WHERE code_id = ?`, [codeId]);
      await conn.query(`DELETE FROM ${codes} WHERE id = ?`, [codeId]);
      await conn.commit();
      return { ok: true };
    } catch (e) {
      try { await conn.rollback(); } catch {}
      throw e;
    } finally {
      conn.release();
    }
  }

  /** Resolve reward items (with name/image) for a set of code ids, keyed by code_id. */
  private async itemsForCodes(codeIds: number[]): Promise<Map<number, AdminCodeItem[]>> {
    const byCode = new Map<number, AdminCodeItem[]>();
    if (codeIds.length === 0) return byCode;

    const codeItems = this.db.table('rc', 'code_items');
    const itemsT = this.db.table('sv', 'items');
    const vehiclesT = this.db.table('sv', 'vehicles');

    // kind 0 = item (sv_items), kind 1 = vehicle (sv_vehicles). Separate id spaces, so join both and pick by kind.
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
    for (const it of items) {
      const arr = byCode.get(Number(it.code_id)) || [];
      arr.push({ item_id: Number(it.item_id), kind: Number(it.kind), amount: Number(it.amount), name: it.name, image_url: it.image_url });
      byCode.set(Number(it.code_id), arr);
    }
    return byCode;
  }

  private toRow(r: any, items: AdminCodeItem[]): AdminCodeRow {
    return {
      code_id: Number(r.code_id),
      code: r.code,
      max_uses: Number(r.max_uses),
      uses: Number(r.uses),
      enabled: Number(r.enabled),
      expires_at: r.expires_at,
      created_at: r.created_at,
      status: computeStatus(r),
      items,
    };
  }
}
