import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { DbService } from '../database/db.service';
import { periodKey, QuestResetType } from '../common/period-key';

/** Convert an ISO-8601 string from the frontend into a Date that mysql2 will
 *  serialize to MySQL DATETIME. Returns null for null/undefined/empty/invalid. */
function toMysqlDateTime(iso: string | null | undefined): Date | null {
  if (!iso) return null;
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? null : d;
}

export interface QuestItem {
  item_id: number;
  qty_required: number;
  item_name?: string | null;
}

export interface QuestRow {
  id: number;
  name: string;
  description: string | null;
  reward_coins: number;
  reset_type: QuestResetType;
  enabled: number;
  start_at: Date | null;
  end_at: Date | null;
  created_at: Date;
  updated_at: Date;
}

export interface QuestWithItems extends QuestRow {
  items: QuestItem[];
}

export interface UpsertQuestInput {
  name: string;
  description: string | null;
  reward_coins: number;
  reset_type: QuestResetType;
  enabled: boolean;
  start_at: string | null;
  end_at: string | null;
  items: QuestItem[];
}

export interface PlayerQuestItem extends QuestItem {
  sold_qty: number;
  item_name: string | null;
}

export interface PlayerQuest {
  id: number;
  name: string;
  description: string | null;
  reward_coins: number;
  reset_type: QuestResetType;
  period_key: string;
  completed: boolean;
  completed_at: Date | null;
  items: PlayerQuestItem[];
}

export interface QuestCompletionRow {
  quest_id: number;
  name: string;
  period_key: string;
  reward_coins: number;
  completed_at: Date;
}

@Injectable()
export class QuestsService {
  constructor(private readonly db: DbService) {}

  // -------- admin --------

  async listAll(): Promise<QuestWithItems[]> {
    const quests = this.db.table('sv', 'quests');
    const items = this.db.table('sv', 'quest_items');
    const rows = await this.db.query<QuestRow>(
      `SELECT id, name, description, reward_coins, reset_type, enabled, start_at, end_at, created_at, updated_at
       FROM ${quests} ORDER BY id ASC`,
    );
    if (rows.length === 0) return [];
    const ids = rows.map((r) => r.id);
    const catalog = this.db.table('sv', 'items');
    const itemRows = await this.db.query<QuestItem & { quest_id: number }>(
      `SELECT qi.quest_id, qi.item_id, qi.qty_required, c.name AS item_name
       FROM ${items} qi
       LEFT JOIN ${catalog} c ON c.id = qi.item_id
       WHERE qi.quest_id IN (${ids.map(() => '?').join(',')})`,
      ids,
    );
    const byQuest = new Map<number, QuestItem[]>();
    for (const it of itemRows) {
      const arr = byQuest.get(it.quest_id) || [];
      arr.push({ item_id: it.item_id, qty_required: it.qty_required, item_name: it.item_name ?? null });
      byQuest.set(it.quest_id, arr);
    }
    return rows.map((r) => ({ ...r, items: byQuest.get(r.id) || [] }));
  }

  async getOne(id: number): Promise<QuestWithItems> {
    const quests = this.db.table('sv', 'quests');
    const items = this.db.table('sv', 'quest_items');
    const row = await this.db.first<QuestRow>(
      `SELECT id, name, description, reward_coins, reset_type, enabled, start_at, end_at, created_at, updated_at
       FROM ${quests} WHERE id = ?`,
      [id],
    );
    if (!row) throw new NotFoundException('Quest not found');
    const catalog = this.db.table('sv', 'items');
    const itemRows = await this.db.query<QuestItem>(
      `SELECT qi.item_id, qi.qty_required, c.name AS item_name
       FROM ${items} qi
       LEFT JOIN ${catalog} c ON c.id = qi.item_id
       WHERE qi.quest_id = ? ORDER BY qi.item_id ASC`,
      [id],
    );
    return { ...row, items: itemRows };
  }

  async create(i: UpsertQuestInput): Promise<QuestWithItems> {
    if (!i.items || i.items.length === 0) throw new BadRequestException('items required');
    const quests = this.db.table('sv', 'quests');
    const items = this.db.table('sv', 'quest_items');
    const conn = await this.db.getConnection();
    try {
      await conn.beginTransaction();
      const [res]: any = await conn.query(
        `INSERT INTO ${quests} (name, description, reward_coins, reset_type, enabled, start_at, end_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [i.name, i.description, i.reward_coins, i.reset_type, i.enabled ? 1 : 0,
         toMysqlDateTime(i.start_at), toMysqlDateTime(i.end_at)],
      );
      const id = Number(res.insertId);
      for (const it of i.items) {
        await conn.query(
          `INSERT INTO ${items} (quest_id, item_id, qty_required) VALUES (?, ?, ?)`,
          [id, it.item_id, it.qty_required],
        );
      }
      await conn.commit();
      return this.getOne(id);
    } catch (e) {
      await conn.rollback();
      throw e;
    } finally {
      conn.release();
    }
  }

  async update(id: number, i: UpsertQuestInput): Promise<QuestWithItems> {
    if (!i.items || i.items.length === 0) throw new BadRequestException('items required');
    const quests = this.db.table('sv', 'quests');
    const items = this.db.table('sv', 'quest_items');
    const conn = await this.db.getConnection();
    try {
      await conn.beginTransaction();
      await conn.query(
        `UPDATE ${quests} SET name = ?, description = ?, reward_coins = ?, reset_type = ?,
           enabled = ?, start_at = ?, end_at = ? WHERE id = ?`,
        [i.name, i.description, i.reward_coins, i.reset_type, i.enabled ? 1 : 0,
         toMysqlDateTime(i.start_at), toMysqlDateTime(i.end_at), id],
      );
      await conn.query(`DELETE FROM ${items} WHERE quest_id = ?`, [id]);
      for (const it of i.items) {
        await conn.query(
          `INSERT INTO ${items} (quest_id, item_id, qty_required) VALUES (?, ?, ?)`,
          [id, it.item_id, it.qty_required],
        );
      }
      await conn.commit();
      return this.getOne(id);
    } catch (e) {
      await conn.rollback();
      throw e;
    } finally {
      conn.release();
    }
  }

  async remove(id: number): Promise<{ ok: true; deleted: number }> {
    const quests = this.db.table('sv', 'quests');
    const result: any = await this.db.query(`DELETE FROM ${quests} WHERE id = ?`, [id]);
    const affected = Array.isArray(result) ? 0 : Number(result?.affectedRows || 0);
    return { ok: true, deleted: affected };
  }

  // -------- player --------

  /** Active = enabled, within optional start_at/end_at window, and not completed for current period. */
  async listActiveForPlayer(steamId: string): Promise<PlayerQuest[]> {
    const questsT = this.db.table('sv', 'quests');
    const itemsT = this.db.table('sv', 'quest_items');
    const progressT = this.db.table('sv', 'quest_progress');
    const compT = this.db.table('sv', 'quest_completions');

    const quests = await this.db.query<QuestRow>(
      `SELECT id, name, description, reward_coins, reset_type, enabled, start_at, end_at, created_at, updated_at
       FROM ${questsT}
       WHERE enabled = 1
         AND (start_at IS NULL OR start_at <= NOW())
         AND (end_at IS NULL OR end_at >= NOW())
       ORDER BY id ASC`,
    );
    if (quests.length === 0) return [];

    const ids = quests.map((q) => q.id);
    const catalog = this.db.table('sv', 'items');
    const itemRows = await this.db.query<QuestItem & { quest_id: number }>(
      `SELECT qi.quest_id, qi.item_id, qi.qty_required, c.name AS item_name
       FROM ${itemsT} qi
       LEFT JOIN ${catalog} c ON c.id = qi.item_id
       WHERE qi.quest_id IN (${ids.map(() => '?').join(',')})`,
      ids,
    );
    const byQuestItems = new Map<number, QuestItem[]>();
    for (const it of itemRows) {
      const arr = byQuestItems.get(it.quest_id) || [];
      arr.push({ item_id: it.item_id, qty_required: it.qty_required, item_name: it.item_name ?? null });
      byQuestItems.set(it.quest_id, arr);
    }

    const result: PlayerQuest[] = [];
    for (const q of quests) {
      const pk = periodKey(q.reset_type);
      const completion = await this.db.first<{ completed_at: Date }>(
        `SELECT completed_at FROM ${compT} WHERE quest_id = ? AND steam_id = ? AND period_key = ?`,
        [q.id, steamId, pk],
      );
      const progressRows = await this.db.query<{ item_id: number; sold_qty: number }>(
        `SELECT item_id, sold_qty FROM ${progressT}
         WHERE quest_id = ? AND steam_id = ? AND period_key = ?`,
        [q.id, steamId, pk],
      );
      const progByItem = new Map<number, number>();
      for (const p of progressRows) progByItem.set(p.item_id, Number(p.sold_qty));

      const itemsList: PlayerQuestItem[] = (byQuestItems.get(q.id) || []).map((it) => ({
        item_id: it.item_id,
        qty_required: it.qty_required,
        item_name: it.item_name ?? null,
        sold_qty: progByItem.get(it.item_id) || 0,
      }));

      result.push({
        id: q.id,
        name: q.name,
        description: q.description,
        reward_coins: Number(q.reward_coins),
        reset_type: q.reset_type,
        period_key: pk,
        completed: !!completion,
        completed_at: completion?.completed_at ?? null,
        items: itemsList,
      });
    }
    return result;
  }

  async getOneForPlayer(id: number, steamId: string): Promise<PlayerQuest> {
    const questsT = this.db.table('sv', 'quests');
    const itemsT = this.db.table('sv', 'quest_items');
    const progressT = this.db.table('sv', 'quest_progress');
    const compT = this.db.table('sv', 'quest_completions');

    const q = await this.db.first<QuestRow>(
      `SELECT id, name, description, reward_coins, reset_type, enabled, start_at, end_at, created_at, updated_at
       FROM ${questsT} WHERE id = ?`,
      [id],
    );
    if (!q) throw new NotFoundException('Quest not found');

    const pk = periodKey(q.reset_type);
    const catalog = this.db.table('sv', 'items');
    const items = await this.db.query<QuestItem>(
      `SELECT qi.item_id, qi.qty_required, c.name AS item_name
       FROM ${itemsT} qi
       LEFT JOIN ${catalog} c ON c.id = qi.item_id
       WHERE qi.quest_id = ?`, [id],
    );
    const progRows = await this.db.query<{ item_id: number; sold_qty: number }>(
      `SELECT item_id, sold_qty FROM ${progressT}
       WHERE quest_id = ? AND steam_id = ? AND period_key = ?`,
      [id, steamId, pk],
    );
    const progByItem = new Map<number, number>();
    for (const p of progRows) progByItem.set(p.item_id, Number(p.sold_qty));

    const completion = await this.db.first<{ completed_at: Date }>(
      `SELECT completed_at FROM ${compT} WHERE quest_id = ? AND steam_id = ? AND period_key = ?`,
      [id, steamId, pk],
    );

    return {
      id: q.id,
      name: q.name,
      description: q.description,
      reward_coins: Number(q.reward_coins),
      reset_type: q.reset_type,
      period_key: pk,
      completed: !!completion,
      completed_at: completion?.completed_at ?? null,
      items: items.map((it) => ({
        item_id: it.item_id,
        qty_required: it.qty_required,
        item_name: it.item_name ?? null,
        sold_qty: progByItem.get(it.item_id) || 0,
      })),
    };
  }

  async history(steamId: string, limit = 50): Promise<QuestCompletionRow[]> {
    const compT = this.db.table('sv', 'quest_completions');
    const questsT = this.db.table('sv', 'quests');
    return this.db.query<QuestCompletionRow>(
      `SELECT c.quest_id, q.name, c.period_key, c.reward_coins, c.completed_at
       FROM ${compT} c
       LEFT JOIN ${questsT} q ON q.id = c.quest_id
       WHERE c.steam_id = ?
       ORDER BY c.completed_at DESC
       LIMIT ?`,
      [steamId, limit],
    );
  }
}
