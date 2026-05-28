import { Injectable } from '@nestjs/common';
import { DbService } from '../database/db.service';
import { Paginated, normalizePage } from '../common/pagination';

export interface CodeItem { item_id: number; amount: number; name: string | null; image_url: string | null; }
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
    const items = await this.db.query<any>(
      `SELECT ci.code_id, ci.item_id, ci.amount, i.name, i.image_url
       FROM ${codeItems} ci
       LEFT JOIN ${itemsT} i ON i.id = ci.item_id
       WHERE ci.code_id IN (${codeIds.map(() => '?').join(',')})`,
      codeIds,
    );

    const byCode = new Map<number, CodeItem[]>();
    for (const it of items) {
      const arr = byCode.get(Number(it.code_id)) || [];
      arr.push({ item_id: Number(it.item_id), amount: Number(it.amount), name: it.name, image_url: it.image_url });
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
}
