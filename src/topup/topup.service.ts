import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as mysql from 'mysql2/promise';
import { DbService } from '../database/db.service';
import { Paginated, normalizePage } from '../common/pagination';
import { JwtPayload } from '../auth/strategies/jwt.strategy';
import { PlernpayService } from './plernpay.service';
import { TopupDbService } from './topup-db.service';
import {
  TopupCreateView,
  TopupRow,
  TopupStatusView,
  VcoinBalanceView,
} from './topup.types';

@Injectable()
export class TopupService {
  private readonly log = new Logger(TopupService.name);

  constructor(
    private readonly topupDb: TopupDbService,
    private readonly plernpay: PlernpayService,
    private readonly cfg: ConfigService,
    /** External shop DB — used READ-ONLY here, only to resolve steam_id from sv_links. */
    private readonly shopDb: DbService,
  ) {}

  private linksTbl() { return this.shopDb.table('sv', 'links'); }

  private vcoinPerBaht(): number {
    const v = Number(this.cfg.get<number>('topup.vcoinPerBaht') ?? 1);
    return Number.isFinite(v) && v > 0 ? v : 1;
  }
  private minBaht(): number {
    const v = Number(this.cfg.get<number>('topup.minBaht') ?? 1);
    return Number.isFinite(v) && v >= 1 ? Math.floor(v) : 1;
  }
  private maxBaht(): number {
    const v = Number(this.cfg.get<number>('topup.maxBaht') ?? 10000);
    return Number.isFinite(v) && v >= 1 ? Math.floor(v) : 10000;
  }

  /**
   * Resolve the canonical steam_id for the authenticated user.
   * - steam-login JWT carries steam_id directly.
   * - discord-login JWT: READ-ONLY lookup of sv_links (external shop DB).
   * Throws 400 `link_steam_first` when no steam can be resolved.
   * Returns the discord_id alongside (for the topups.discord_id audit column), or null.
   */
  async resolveIdentity(user: JwtPayload): Promise<{ steamId: string; discordId: string | null }> {
    if (user.steam_id) {
      return { steamId: String(user.steam_id), discordId: user.sub ?? null };
    }
    if (user.sub) {
      const row = await this.shopDb.first<{ steam_id: string }>(
        `SELECT steam_id FROM ${this.linksTbl()} WHERE discord_id = ? LIMIT 1`,
        [user.sub],
      );
      if (row?.steam_id) return { steamId: String(row.steam_id), discordId: user.sub };
    }
    throw new BadRequestException('link_steam_first');
  }

  /** POST /topup/create */
  async create(user: JwtPayload, baht: number): Promise<TopupCreateView> {
    // Validate an integer-ish baht amount within the configured bounds.
    if (!Number.isFinite(baht) || Math.floor(baht) !== baht) {
      throw new BadRequestException('baht must be an integer');
    }
    const min = this.minBaht();
    const max = this.maxBaht();
    if (baht < min || baht > max) {
      throw new BadRequestException(`baht must be between ${min} and ${max}`);
    }

    const { steamId, discordId } = await this.resolveIdentity(user);
    const vcoins = Math.round(baht * this.vcoinPerBaht());

    // Create the gateway charge first; memo carries lightweight reconciliation info.
    const created = await this.plernpay.createTopup(baht, `topup steam:${steamId}`);

    // Persist the pending top-up in the Pi5-local DB ONLY.
    await this.topupDb.query(
      `INSERT INTO topups
         (ref, steam_id, discord_id, baht, unique_amount, vcoins, qr_code, promptpay_id, status, expires_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?)`,
      [
        created.ref, steamId, discordId, baht, created.unique_amount, vcoins,
        created.qr_code, created.promptpay_id, this.toMysqlDate(created.expires_at),
      ],
    );

    return {
      ref: created.ref,
      unique_amount: Number(created.unique_amount),
      qr_code: created.qr_code,
      promptpay_id: created.promptpay_id,
      expires_at: created.expires_at ?? null,
      vcoins,
      status: 'pending',
    };
  }

  /** GET /topup/:ref — owner only. Reads Pi5 only; the poller owns confirmation. */
  async getOwned(user: JwtPayload, ref: string): Promise<TopupStatusView> {
    const { steamId } = await this.resolveIdentity(user);
    const row = await this.topupDb.first<TopupRow>(
      `SELECT * FROM topups WHERE ref = ?`, [ref],
    );
    if (!row) throw new NotFoundException('topup_not_found');
    if (String(row.steam_id) !== steamId) throw new ForbiddenException('not_owner');
    return this.toStatusView(row);
  }

  /** GET /topup/me — paginated history for the resolved steam_id. */
  async history(user: JwtPayload, page?: number, limit?: number): Promise<Paginated<TopupStatusView>> {
    const { steamId } = await this.resolveIdentity(user);
    const np = normalizePage(page, limit);
    const cnt = await this.topupDb.first<{ c: number }>(
      `SELECT COUNT(*) AS c FROM topups WHERE steam_id = ?`, [steamId],
    );
    const total = cnt ? Number(cnt.c) : 0;
    const rows = await this.topupDb.query<TopupRow>(
      `SELECT * FROM topups WHERE steam_id = ? ORDER BY id DESC LIMIT ? OFFSET ?`,
      [steamId, np.limit, np.offset],
    );
    return {
      items: rows.map((r) => this.toStatusView(r)),
      total, page: np.page, limit: np.limit, pages: Math.ceil(total / np.limit),
    };
  }

  /** GET /vcoins/me — current Vcoin balance (0 if no wallet row yet). */
  async vcoinBalance(user: JwtPayload): Promise<VcoinBalanceView> {
    const { steamId } = await this.resolveIdentity(user);
    const row = await this.topupDb.first<{ balance: string }>(
      `SELECT balance FROM v_coins WHERE steam_id = ?`, [steamId],
    );
    return { steam_id: steamId, balance: row ? Number(row.balance) : 0 };
  }

  // ---- Poller-facing helpers (Pi5 only) ------------------------------------

  /** Oldest pending, not-yet-expired top-ups (the poller polls these against PlernPay). */
  async findPollable(limit: number): Promise<TopupRow[]> {
    return this.topupDb.query<TopupRow>(
      `SELECT * FROM topups
        WHERE status = 'pending' AND (expires_at IS NULL OR expires_at > NOW())
        ORDER BY id ASC
        LIMIT ?`,
      [limit],
    );
  }

  /** Pending rows whose expiry has passed — swept to 'expired'. */
  async findExpiredPending(limit: number): Promise<TopupRow[]> {
    return this.topupDb.query<TopupRow>(
      `SELECT * FROM topups
        WHERE status = 'pending' AND expires_at IS NOT NULL AND expires_at <= NOW()
        ORDER BY id ASC
        LIMIT ?`,
      [limit],
    );
  }

  /**
   * Confirm + credit a top-up atomically in the Pi5 DB. Idempotent: the status guard
   * (`AND status='pending'`) means a double-fire credits at most once.
   * Returns true if THIS call performed the credit.
   */
  async confirmAndCredit(row: TopupRow): Promise<boolean> {
    const conn = await this.topupDb.getConnection();
    try {
      await conn.beginTransaction();
      const [upd] = await conn.query<mysql.ResultSetHeader>(
        `UPDATE topups SET status='credited', confirmed_at=NOW(), credited_at=NOW()
          WHERE ref = ? AND status='pending'`,
        [row.ref],
      );
      if (upd.affectedRows !== 1) {
        // Someone else already handled it (or it's no longer pending) — do nothing.
        await conn.rollback();
        return false;
      }
      await conn.query(
        `INSERT INTO v_coins (steam_id, balance) VALUES (?, ?)
         ON DUPLICATE KEY UPDATE balance = balance + VALUES(balance)`,
        [row.steam_id, row.vcoins],
      );
      await conn.query(
        `INSERT INTO v_coin_log (steam_id, delta, reason, ref) VALUES (?, ?, 'topup', ?)`,
        [row.steam_id, row.vcoins, row.ref],
      );
      await conn.commit();
      return true;
    } catch (e) {
      try { await conn.rollback(); } catch { /* ignore */ }
      throw e;
    } finally {
      conn.release();
    }
  }

  /** Mark a still-pending, expired row as 'expired'. Guarded so we never clobber a credit. */
  async markExpired(ref: string): Promise<void> {
    await this.topupDb.query(
      `UPDATE topups SET status='expired' WHERE ref = ? AND status='pending'`,
      [ref],
    );
  }

  // ---- mapping helpers ------------------------------------------------------

  private toStatusView(r: TopupRow): TopupStatusView {
    return {
      ref: r.ref,
      status: r.status,
      unique_amount: Number(r.unique_amount),
      vcoins: Number(r.vcoins),
      expires_at: r.expires_at,
      credited_at: r.credited_at,
    };
  }

  /** Convert an ISO-ish gateway timestamp to a MySQL DATETIME string, or null. */
  private toMysqlDate(iso: string | null | undefined): string | null {
    if (!iso) return null;
    const d = new Date(iso);
    if (isNaN(d.getTime())) return null;
    return d.toISOString().slice(0, 19).replace('T', ' ');
  }
}
