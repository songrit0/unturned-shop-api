import {
  ConflictException,
  Injectable,
  InternalServerErrorException,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import * as mysql from 'mysql2/promise';
import { DbService } from '../database/db.service';
import { Paginated, normalizePage } from '../common/pagination';
import { VaultDetail, VaultItem, VaultItemView, VaultSummary } from './vaults.types';
import { buildGunView, collectAttachmentIds, parseGunState } from '../p2p/gun-state';

const LOCK_HOLDER = 'web-api';
const LOCK_TTL_MIN = 15;

interface VaultRow {
  OwnerId: string;
  Name: string;
  OwnerName: string | null;
  Data: Buffer | string | null;
  LastUpdate: Date | null;
}

@Injectable()
export class VaultsService {
  private readonly log = new Logger(VaultsService.name);

  constructor(private readonly db: DbService) {}

  vaultsTbl() { return this.db.tableRaw('Vaults'); }
  locksTbl() { return this.db.tableRaw('VaultsLocks'); }

  /** Parse `Data` blob to VaultItem[]. Exposed for p2p reuse. */
  parseVaultData(raw: Buffer | string | null): VaultItem[] {
    return this.parseData(raw);
  }

  /** Serialize VaultItem[] to a string matching the plugin's expected shape. */
  serializeVaultData(items: VaultItem[]): string {
    return this.serializeData(items);
  }

  /** Parse Data blob -> VaultItem[]. Empty/null -> []. Throws on malformed JSON. */
  private parseData(raw: Buffer | string | null): VaultItem[] {
    if (raw == null) return [];
    const text = Buffer.isBuffer(raw) ? raw.toString('utf8') : String(raw);
    const trimmed = text.trim();
    if (!trimmed) return [];
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch (e: any) {
      throw new InternalServerErrorException(`Vault Data JSON parse failed: ${e.message}`);
    }
    if (!Array.isArray(parsed)) {
      throw new InternalServerErrorException('Vault Data is not a JSON array');
    }
    return parsed as VaultItem[];
  }

  /** Serialize items array back to the exact shape the plugin expects. State strings are passed through unchanged. */
  private serializeData(items: VaultItem[]): string {
    return JSON.stringify(items.map((it) => ({
      X: it.X,
      Y: it.Y,
      Rot: it.Rot,
      Amount: it.Amount,
      Quality: it.Quality,
      State: it.State,
      Id: it.Id,
    })));
  }

  async findByOwner(steamId: string): Promise<VaultSummary[]> {
    const vaults = this.vaultsTbl();
    const rows = await this.db.query<VaultRow>(
      `SELECT OwnerId, Name, OwnerName, Data, LastUpdate
       FROM ${vaults} WHERE OwnerId = ?`,
      [steamId],
    );
    return rows.map((r) => ({
      owner_steam: String(r.OwnerId),
      owner_name: r.OwnerName,
      name: r.Name,
      item_count: this.parseData(r.Data).length,
      last_update: r.LastUpdate,
    }));
  }

  async getVault(steamId: string, name: string): Promise<VaultDetail> {
    const vaults = this.vaultsTbl();
    const items = this.db.table('sv', 'items');
    const types = this.db.table('sv', 'item_types');

    const row = await this.db.first<VaultRow>(
      `SELECT OwnerId, Name, OwnerName, Data, LastUpdate
       FROM ${vaults} WHERE OwnerId = ? AND Name = ?`,
      [steamId, name],
    );
    if (!row) throw new NotFoundException('Vault not found');

    const parsed = this.parseData(row.Data);
    // Parse gun state per item up front so attachment ids join the single metadata lookup.
    const guns = parsed.map((it) => parseGunState(it.State));
    const idSet = new Set<number>();
    for (const it of parsed) if (Number.isFinite(it.Id)) idSet.add(Number(it.Id));
    for (const g of guns) if (g) for (const aid of collectAttachmentIds(g)) idSet.add(aid);
    const itemIds = [...idSet];

    let metaById = new Map<number, { name: string; description: string | null; image_url: string | null; type_id: number | null; type_name: string | null }>();
    if (itemIds.length > 0) {
      const placeholders = itemIds.map(() => '?').join(',');
      const meta = await this.db.query<{ id: number; name: string; description: string | null; image_url: string | null; type_id: number | null; type_name: string | null }>(
        `SELECT i.id, i.name, i.description, i.image_url, i.type_id, t.name AS type_name
         FROM ${items} i LEFT JOIN ${types} t ON t.id = i.type_id
         WHERE i.id IN (${placeholders})`,
        itemIds,
      );
      metaById = new Map(meta.map((m) => [Number(m.id), { name: m.name, description: m.description, image_url: m.image_url, type_id: m.type_id, type_name: m.type_name }]));
    }

    // id -> name map for attachment resolution (reuses the metadata we just fetched).
    const nameById = new Map<number, string | null>();
    for (const [id, m] of metaById) nameById.set(id, m.name ?? null);

    const itemsView: VaultItemView[] = parsed.map((it, i) => {
      const m = metaById.get(Number(it.Id));
      const g = guns[i];
      return {
        ...it,
        name: m?.name ?? null,
        description: m?.description ?? null,
        image_url: m?.image_url ?? null,
        type_id: m?.type_id ?? null,
        type_name: m?.type_name ?? null,
        gun: g ? buildGunView(g, nameById) : null,
      };
    });

    return {
      owner_steam: String(row.OwnerId),
      owner_name: row.OwnerName,
      name: row.Name,
      item_count: parsed.length,
      last_update: row.LastUpdate,
      items: itemsView,
    };
  }

  async listAll(filters: {
    steamId?: string;
    name?: string;
    discordId?: string;
    q?: string;
    page?: number;
    limit?: number;
  }): Promise<Paginated<VaultSummary>> {
    const np = normalizePage(filters.page, filters.limit);
    const vaults = this.vaultsTbl();
    const links = this.db.table('sv', 'links');
    const where: string[] = ['1=1'];
    const params: any[] = [];
    if (filters.steamId) { where.push('OwnerId = ?'); params.push(filters.steamId); }
    if (filters.name)    { where.push('Name = ?');    params.push(filters.name); }
    if (filters.discordId) {
      where.push(`OwnerId IN (SELECT steam_id FROM ${links} WHERE discord_id = ?)`);
      params.push(filters.discordId);
    }
    if (filters.q && filters.q.trim()) {
      const term = filters.q.trim();
      where.push('(OwnerName LIKE ? OR OwnerId LIKE ?)');
      params.push(`%${term}%`, `${term}%`);
    }
    const whereSql = where.join(' AND ');

    const cnt = await this.db.first<{ c: number }>(`SELECT COUNT(*) AS c FROM ${vaults} WHERE ${whereSql}`, params);
    const total = cnt ? Number(cnt.c) : 0;

    const rows = await this.db.query<VaultRow>(
      `SELECT OwnerId, Name, OwnerName, Data, LastUpdate
       FROM ${vaults} WHERE ${whereSql}
       ORDER BY LastUpdate DESC
       LIMIT ? OFFSET ?`,
      [...params, np.limit, np.offset],
    );
    const items = rows.map((r) => ({
      owner_steam: String(r.OwnerId),
      owner_name: r.OwnerName,
      name: r.Name,
      item_count: this.parseData(r.Data).length,
      last_update: r.LastUpdate,
    }));
    return { items, total, page: np.page, limit: np.limit, pages: Math.ceil(total / np.limit) };
  }

  /** Bulk replace items. Acquires VaultsLocks first; rejects 409 if plugin holds the lock. */
  async updateVault(steamId: string, name: string, items: VaultItem[]): Promise<VaultDetail> {
    const conn = await this.db.getConnection();
    try {
      await this.acquireLock(conn, steamId, name);
      try {
        await conn.beginTransaction();
        const vaults = this.vaultsTbl();
        const [existing] = await conn.query<mysql.RowDataPacket[]>(
          `SELECT OwnerId FROM ${vaults} WHERE OwnerId = ? AND Name = ? FOR UPDATE`,
          [steamId, name],
        );
        if (existing.length === 0) {
          await conn.rollback();
          throw new NotFoundException('Vault not found');
        }
        const data = this.serializeData(items);
        await conn.query(
          `UPDATE ${vaults} SET Data = ?, LastUpdate = NOW() WHERE OwnerId = ? AND Name = ?`,
          [data, steamId, name],
        );
        await conn.commit();
      } catch (e) {
        try { await conn.rollback(); } catch { /* ignore */ }
        throw e;
      } finally {
        await this.releaseLock(conn, steamId, name);
      }
    } finally {
      conn.release();
    }
    return this.getVault(steamId, name);
  }

  /**
   * Acquire VaultsLocks for (OwnerId, Name). The lock is considered free if no row exists
   * OR the existing row is older than LOCK_TTL_MIN OR already held by us.
   *
   * Strategy: INSERT ... ON DUPLICATE KEY UPDATE that only overwrites when the existing
   * row is stale or ours, then re-SELECT to confirm we own it.
   */
  async acquireLock(conn: mysql.PoolConnection, steamId: string, name: string): Promise<void> {
    const locks = this.locksTbl();
    // Try to insert / steal stale lock atomically.
    await conn.query(
      `INSERT INTO ${locks} (OwnerId, Name, LockedBy, LockedAt)
         VALUES (?, ?, ?, NOW())
       ON DUPLICATE KEY UPDATE
         LockedBy = IF(LockedBy = VALUES(LockedBy) OR LockedAt < (NOW() - INTERVAL ${LOCK_TTL_MIN} MINUTE),
                       VALUES(LockedBy),
                       LockedBy),
         LockedAt = IF(LockedBy = VALUES(LockedBy) OR LockedAt < (NOW() - INTERVAL ${LOCK_TTL_MIN} MINUTE),
                       VALUES(LockedAt),
                       LockedAt)`,
      [steamId, name, LOCK_HOLDER],
    );
    const [rows] = await conn.query<mysql.RowDataPacket[]>(
      `SELECT LockedBy, LockedAt FROM ${locks} WHERE OwnerId = ? AND Name = ?`,
      [steamId, name],
    );
    const row = rows[0] as { LockedBy: string; LockedAt: Date } | undefined;
    if (!row || row.LockedBy !== LOCK_HOLDER) {
      throw new ConflictException('vault_locked_in_game');
    }
  }

  async releaseLock(conn: mysql.PoolConnection, steamId: string, name: string): Promise<void> {
    const locks = this.locksTbl();
    try {
      await conn.query(
        `DELETE FROM ${locks} WHERE OwnerId = ? AND Name = ? AND LockedBy = ?`,
        [steamId, name, LOCK_HOLDER],
      );
    } catch (e: any) {
      this.log.warn(`releaseLock failed for (${steamId}, ${name}): ${e.message}`);
    }
  }
}
