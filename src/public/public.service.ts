import { Injectable, Logger } from '@nestjs/common';
import { DbService } from '../database/db.service';
import { TopupService } from '../topup/topup.service';
import { PlayerStatsService, PlayerStatsEntry } from '../player-stats/player-stats.service';

/** Live server status, derived from the ScheduledRestart plugin's `sr_status` row (id=1).
 *  `online` mirrors the Discord bot's rule: the plugin must say online AND the row must be
 *  fresh (written within STALE_AFTER_SECONDS) — a frozen row means the plugin stopped ticking. */
export interface ServerStatus {
  online: boolean;
  players: number;
  maxPlayers: number;
  nextRestart: string | null; // ISO (UTC), or null if none scheduled
  state: string;              // 'idle' | 'restarting' | ...
}

/** One latest-market card for the landing page (name + image + price, no gun-view resolution). */
export interface P2pLatestEntry {
  id: number;
  itemId: number;
  itemName: string | null;
  imageUrl: string | null;
  price: number;
  amount: number;
  createdAt: string;
}

export interface DonateTotal {
  communityTotal: number;
  communityGoal: number;
  period: string; // 'YYYY-MM'
}

export interface LandingData {
  server: ServerStatus;
  p2pLatest: P2pLatestEntry[];
  donateTotal: DonateTotal;
  topPlayers: PlayerStatsEntry[];
}

// Mirror of the bot's STALE_AFTER_SECONDS default — a status row older than this means the
// plugin stopped writing, so the server is treated as offline regardless of the stored flag.
const STALE_AFTER_SECONDS = 90;

@Injectable()
export class PublicService {
  private readonly log = new Logger(PublicService.name);

  constructor(
    private readonly db: DbService,
    private readonly topup: TopupService,
    private readonly playerStats: PlayerStatsService,
  ) {}

  /** Everything the unauthenticated landing/login page shows, in one round-trip. */
  async landing(p2pLimit: number, topLimit: number): Promise<LandingData> {
    const [server, p2pLatest, donateTotal, topPlayers] = await Promise.all([
      this.serverStatus(),
      this.p2pLatest(p2pLimit),
      this.donateTotal(),
      this.topPlayers(topLimit),
    ]);
    return { server, p2pLatest, donateTotal, topPlayers };
  }

  /** Read the single sr_status row (id=1) the ScheduledRestart plugin upserts each tick. */
  async serverStatus(): Promise<ServerStatus> {
    const offline: ServerStatus = {
      online: false, players: 0, maxPlayers: 0, nextRestart: null, state: 'offline',
    };
    try {
      const row = await this.db.first<any>(
        // Format next_restart as a literal UTC ISO string in SQL. The DATETIME is stored UTC, but
        // mysql2's default timezone:'local' would re-interpret a JS Date by the host offset, so we
        // emit the 'Z' string directly instead of new Date(col).toISOString().
        `SELECT online, players, max_players, state,
                DATE_FORMAT(next_restart, '%Y-%m-%dT%H:%i:%sZ') AS next_restart,
                TIMESTAMPDIFF(SECOND, updated_at, NOW()) AS age_seconds
         FROM ${this.db.tableRaw('sr_status')} WHERE id = 1`,
      );
      if (!row) return offline;
      const age = row.age_seconds == null ? null : Number(row.age_seconds);
      const fresh = age != null && age <= STALE_AFTER_SECONDS;
      return {
        online: Number(row.online) === 1 && fresh,
        players: Number(row.players) || 0,
        maxPlayers: Number(row.max_players) || 0,
        nextRestart: row.next_restart ?? null,
        state: String(row.state ?? 'idle'),
      };
    } catch (e: any) {
      // sr_status may not exist yet (plugin not deployed) — degrade to "offline", never throw.
      this.log.warn(`serverStatus failed: ${e.message}`);
      return offline;
    }
  }

  /** Latest active P2P listings, newest first. */
  async p2pLatest(limit: number): Promise<P2pLatestEntry[]> {
    const n = Math.min(Math.max(1, limit), 24);
    try {
      const rows = await this.db.query<any>(
        // created_at as a literal UTC ISO string — stored UTC but mysql2 timezone:'local' would
        // otherwise shift it by the host offset on a new Date() re-wrap.
        `SELECT l.id, l.item_id, l.amount, l.price,
                DATE_FORMAT(l.created_at, '%Y-%m-%dT%H:%i:%sZ') AS created_at,
                i.name AS item_name, i.image_url
         FROM ${this.db.table('sv', 'p2p_listings')} l
         LEFT JOIN ${this.db.table('sv', 'items')} i ON i.id = l.item_id
         WHERE l.status = 'active'
         ORDER BY l.created_at DESC
         LIMIT ?`,
        [n],
      );
      return rows.map((r) => ({
        id: Number(r.id),
        itemId: Number(r.item_id),
        itemName: r.item_name ?? null,
        imageUrl: r.image_url ?? null,
        price: Number(r.price),
        amount: Number(r.amount),
        createdAt: r.created_at ?? '',
      }));
    } catch (e: any) {
      this.log.warn(`p2pLatest failed: ${e.message}`);
      return [];
    }
  }

  /** This month's community donation total + goal (Pi5-local topups DB via TopupService). */
  async donateTotal(): Promise<DonateTotal> {
    const { period } = this.topup.monthBounds();
    try {
      const communityTotal = await this.topup.communityTotalThisMonth();
      return { communityTotal, communityGoal: this.topup.monthlyGoalBaht(), period };
    } catch (e: any) {
      this.log.warn(`donateTotal failed: ${e.message}`);
      return { communityTotal: 0, communityGoal: this.topup.monthlyGoalBaht(), period };
    }
  }

  /** Top players by kills (reuses the player-stats leaderboard, already public). */
  async topPlayers(limit: number): Promise<PlayerStatsEntry[]> {
    try {
      return await this.playerStats.leaderboard(limit);
    } catch (e: any) {
      this.log.warn(`topPlayers failed: ${e.message}`);
      return [];
    }
  }
}
