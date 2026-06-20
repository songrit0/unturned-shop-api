import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as mysql from 'mysql2/promise';
import generatePayload from 'promptpay-qr';
import { DbService } from '../database/db.service';
import { Paginated, normalizePage } from '../common/pagination';
import { JwtPayload } from '../auth/strategies/jwt.strategy';
import { PlernpayService } from './plernpay.service';
import { ThunderService } from './thunder.service';
import { TopupDbService } from './topup-db.service';
import { randomBytes } from 'crypto';
import {
  BmcClaimView,
  BmcWebhookResult,
  ProviderRow,
  ThunderCreateView,
  ThunderVerifyView,
  TopupCreateView,
  TopupProvider,
  TopupRow,
  TopupStatusView,
  MeowcoinBalanceView,
} from './topup.types';

const ALLOWED_PROVIDERS: TopupProvider[] = ['plernpay', 'thunder'];

@Injectable()
export class TopupService {
  private readonly log = new Logger(TopupService.name);

  constructor(
    private readonly topupDb: TopupDbService,
    private readonly plernpay: PlernpayService,
    private readonly thunder: ThunderService,
    private readonly cfg: ConfigService,
    /** External shop DB — used READ-ONLY here, only to resolve steam_id from sv_links. */
    private readonly shopDb: DbService,
  ) {}

  private linksTbl() { return this.shopDb.table('sv', 'links'); }

  private meowcoinPerBaht(): number {
    const v = Number(this.cfg.get<number>('topup.meowcoinPerBaht') ?? 1);
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
  /** Admin gate: donations are open to all unless TOPUP_ADMIN_ONLY=true (default false). */
  private adminOnly(): boolean {
    return this.cfg.get<boolean>('topup.adminOnly') === true;
  }
  /** Donate: per-user cap (baht) per calendar month. */
  monthlyCapBaht(): number {
    const v = Number(this.cfg.get<number>('topup.monthlyCapBaht') ?? 150);
    return Number.isFinite(v) && v >= 0 ? Math.floor(v) : 150;
  }
  /** Donate: community-wide monthly goal (baht). */
  monthlyGoalBaht(): number {
    const v = Number(this.cfg.get<number>('topup.monthlyGoalBaht') ?? 1200);
    return Number.isFinite(v) && v >= 0 ? Math.floor(v) : 1200;
  }

  /**
   * Calendar-month bounds in the SERVER'S LOCAL time zone, matching how the topup tables store
   * credited_at (NOW()/CURRENT_TIMESTAMP are local; mysql2 reads back as local). Returns MySQL
   * DATETIME strings [monthStart, nextMonthStart) plus the 'YYYY-MM' period key. A row is "this
   * month" when monthStart <= credited_at < nextMonthStart.
   */
  monthBounds(now: Date = new Date()): { period: string; monthStart: string; nextMonthStart: string } {
    const y = now.getFullYear();
    const m = now.getMonth(); // 0-based
    const start = new Date(y, m, 1, 0, 0, 0, 0);
    const next = new Date(y, m + 1, 1, 0, 0, 0, 0);
    const fmt = (d: Date) => {
      const p = (n: number) => String(n).padStart(2, '0');
      return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} `
        + `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
    };
    const p = (n: number) => String(n).padStart(2, '0');
    return { period: `${y}-${p(m + 1)}`, monthStart: fmt(start), nextMonthStart: fmt(next) };
  }

  /** Sum of a user's CREDITED donations (baht) this calendar month. Counts credited only. */
  async userDonatedThisMonth(steamId: string): Promise<number> {
    const { monthStart, nextMonthStart } = this.monthBounds();
    const row = await this.topupDb.first<{ total: string | number | null }>(
      `SELECT COALESCE(SUM(baht),0) AS total FROM topups
        WHERE steam_id = ? AND status = 'credited' AND credited_at >= ? AND credited_at < ?`,
      [steamId, monthStart, nextMonthStart],
    );
    return row ? Number(row.total) : 0;
  }

  /** Sum of ALL credited donations (baht) this calendar month (community total). */
  async communityTotalThisMonth(): Promise<number> {
    const { monthStart, nextMonthStart } = this.monthBounds();
    const row = await this.topupDb.first<{ total: string | number | null }>(
      `SELECT COALESCE(SUM(baht),0) AS total FROM topups
        WHERE status = 'credited' AND credited_at >= ? AND credited_at < ?`,
      [monthStart, nextMonthStart],
    );
    return row ? Number(row.total) : 0;
  }

  /** Public (no-auth) top-up config for the web to gate its UI + show the rate/limits + providers. */
  async publicConfig() {
    const providers = await this.enabledProviders();
    return {
      admin_only: this.adminOnly(),
      meowcoin_per_baht: this.meowcoinPerBaht(),
      min_baht: this.minBaht(),
      max_baht: this.maxBaht(),
      monthly_cap_baht: this.monthlyCapBaht(),
      monthly_goal_baht: this.monthlyGoalBaht(),
      providers: providers.map((p) => ({ key: p.key, label: p.label })),
      // BuyMeACoffee is a separate, always-external donate link (no create-intent flow like the
      // providers above) — surfaced only when an admin has set BMC_PAGE_URL.
      bmc_page_url: this.cfg.get<string>('bmc.pageUrl') || null,
    };
  }

  /** Enabled providers ordered by sort (for the public config + create-time gate). */
  async enabledProviders(): Promise<ProviderRow[]> {
    return this.topupDb.query<ProviderRow>(
      `SELECT \`key\`, label, enabled, sort FROM topup_providers WHERE enabled = 1 ORDER BY sort ASC, \`key\` ASC`,
    );
  }

  /** True when the named provider exists AND is enabled in the registry. */
  private async isProviderEnabled(key: string): Promise<boolean> {
    const row = await this.topupDb.first<{ enabled: number }>(
      `SELECT enabled FROM topup_providers WHERE \`key\` = ?`, [key],
    );
    return !!row && Number(row.enabled) === 1;
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

  /** POST /topup/create — branches on provider (default 'plernpay'). */
  async create(
    user: JwtPayload,
    baht: number,
    provider: TopupProvider = 'plernpay',
  ): Promise<TopupCreateView | ThunderCreateView> {
    // Donations open to all by default; re-gate to admins only with TOPUP_ADMIN_ONLY=true.
    if (this.adminOnly() && !user.is_admin) {
      throw new ForbiddenException('topup_admin_only');
    }
    if (!ALLOWED_PROVIDERS.includes(provider)) {
      throw new BadRequestException('unknown_provider');
    }
    // Validate an integer-ish baht amount within the configured bounds.
    if (!Number.isFinite(baht) || Math.floor(baht) !== baht) {
      throw new BadRequestException('baht must be an integer');
    }
    const min = this.minBaht();
    const max = this.maxBaht();
    if (baht < min || baht > max) {
      throw new BadRequestException(`baht must be between ${min} and ${max}`);
    }
    // Provider must be enabled in the registry (admin on/off switch).
    if (!(await this.isProviderEnabled(provider))) {
      throw new BadRequestException('provider_disabled');
    }

    const { steamId, discordId } = await this.resolveIdentity(user);

    // Donate monthly cap: a user's CREDITED donations this calendar month + this new amount must
    // not exceed the configured cap. Counts credited only (pending rows don't consume the cap).
    const cap = this.monthlyCapBaht();
    if (cap > 0) {
      const donated = await this.userDonatedThisMonth(steamId);
      if (donated + baht > cap) {
        throw new ForbiddenException('donate_cap_exceeded');
      }
    }

    const meowcoins = Math.round(baht * this.meowcoinPerBaht());

    return provider === 'thunder'
      ? this.createThunder(steamId, discordId, baht, meowcoins)
      : this.createPlernpay(steamId, discordId, baht, meowcoins);
  }

  /** PlernPay auto-PromptPay gateway charge (unchanged flow; poller confirms). */
  private async createPlernpay(
    steamId: string,
    discordId: string | null,
    baht: number,
    meowcoins: number,
  ): Promise<TopupCreateView> {
    // Create the gateway charge first; memo carries lightweight reconciliation info.
    const created = await this.plernpay.createTopup(baht, `topup steam:${steamId}`);

    // Persist the pending top-up in the Pi5-local DB ONLY.
    await this.topupDb.query(
      `INSERT INTO topups
         (ref, steam_id, discord_id, baht, unique_amount, meowcoins, qr_code, promptpay_id, status, provider, expires_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', 'plernpay', ?)`,
      [
        created.ref, steamId, discordId, baht, created.unique_amount, meowcoins,
        created.qr_code, created.promptpay_id, this.toMysqlDate(created.expires_at),
      ],
    );

    return {
      ref: created.ref,
      provider: 'plernpay',
      unique_amount: Number(created.unique_amount),
      qr_code: created.qr_code,
      promptpay_id: created.promptpay_id,
      expires_at: created.expires_at ?? null,
      meowcoins,
      status: 'pending',
    };
  }

  /**
   * Thunder manual-PromptPay path: no gateway charge. We mint our own ref, generate a static
   * PromptPay payload for the configured receiver + amount, and store a pending row. The buyer
   * pays then uploads their slip to POST /topup/thunder/verify, which credits synchronously.
   */
  private async createThunder(
    steamId: string,
    discordId: string | null,
    baht: number,
    meowcoins: number,
  ): Promise<ThunderCreateView> {
    const promptpayId = this.cfg.get<string>('thunder.promptpayId') || '';
    if (!promptpayId) throw new BadRequestException('thunder_not_configured');
    const receiverName = this.cfg.get<string>('thunder.receiverName') || '';

    const ref = `th_${randomBytes(12).toString('hex')}`;
    // EMVCo PromptPay payload string; the web renders the QR from it.
    const payload = generatePayload(promptpayId, { amount: baht });

    await this.topupDb.query(
      `INSERT INTO topups
         (ref, steam_id, discord_id, baht, unique_amount, meowcoins, qr_code, promptpay_id, status, provider)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', 'thunder')`,
      [ref, steamId, discordId, baht, baht, meowcoins, payload, promptpayId],
    );

    return {
      ref,
      provider: 'thunder',
      qr_code: payload,
      promptpay_id: promptpayId,
      receiver_name: receiverName || null,
      amount: baht,
      meowcoins,
      expires_at: null,
      status: 'pending',
    };
  }

  /**
   * POST /topup/thunder/verify — owner uploads a bank slip; verify + credit synchronously.
   * On any validation failure we throw 400 with a reason code and credit NOTHING.
   */
  async thunderVerify(user: JwtPayload, ref: string, slipBase64: string): Promise<ThunderVerifyView> {
    const { steamId } = await this.resolveIdentity(user);
    if (!slipBase64 || typeof slipBase64 !== 'string') {
      throw new BadRequestException('slip_base64_required');
    }

    const row = await this.topupDb.first<TopupRow>(`SELECT * FROM topups WHERE ref = ?`, [ref]);
    if (!row || row.provider !== 'thunder') throw new NotFoundException('topup_not_found');
    if (String(row.steam_id) !== steamId) throw new NotFoundException('topup_not_found');
    if (row.status !== 'pending') throw new ConflictException('topup_not_pending');

    // Verify the slip against our account, requiring the slip amount to match the row's baht.
    const result = await this.thunder.verifyBase64(slipBase64, Number(row.baht), `topup ${ref}`);

    // Validation — fail closed, never credit on a bad slip.
    if (result?.success !== true) throw new BadRequestException('slip_not_matched');
    const d = result.data;
    if (!d) throw new BadRequestException('slip_not_matched');
    if (d.isDuplicate === true) throw new BadRequestException('duplicate_slip');
    if (d.matchedAccount !== true) throw new BadRequestException('slip_not_matched');
    if (d.isAmountMatched === false) throw new BadRequestException('amount_mismatch');
    const transRef = d.rawSlip?.transRef;
    if (!transRef) throw new BadRequestException('slip_no_trans_ref');

    // Credit using the amount actually seen in the slip (defends against a tampered row.baht).
    const amountInSlip = Number(d.amountInSlip);
    if (!Number.isFinite(amountInSlip) || amountInSlip <= 0) {
      throw new BadRequestException('amount_mismatch');
    }
    const creditMeowcoins = Math.round(amountInSlip * this.meowcoinPerBaht());

    const conn = await this.topupDb.getConnection();
    try {
      await conn.beginTransaction();

      // Stamp the transRef first. The UNIQUE index rejects a slip already used by ANY row.
      try {
        const [upd] = await conn.query<mysql.ResultSetHeader>(
          `UPDATE topups
              SET trans_ref = ?, status='credited', credited_at=NOW(), confirmed_at=NOW(), meowcoins = ?
            WHERE ref = ? AND status='pending'`,
          [transRef, creditMeowcoins, ref],
        );
        if (upd.affectedRows !== 1) {
          await conn.rollback();
          throw new ConflictException('topup_not_pending');
        }
      } catch (e: any) {
        await conn.rollback();
        if (e?.code === 'ER_DUP_ENTRY') throw new ConflictException('slip_already_used');
        throw e;
      }

      await conn.query(
        `INSERT INTO meow_coins (steam_id, balance) VALUES (?, ?)
         ON DUPLICATE KEY UPDATE balance = balance + VALUES(balance)`,
        [steamId, creditMeowcoins],
      );
      await conn.query(
        `INSERT INTO meow_coin_log (steam_id, delta, reason, ref) VALUES (?, ?, 'topup_thunder', ?)`,
        [steamId, creditMeowcoins, transRef],
      );

      const [balRows] = await conn.query<mysql.RowDataPacket[]>(
        `SELECT balance FROM meow_coins WHERE steam_id = ?`, [steamId],
      );
      await conn.commit();

      const balance = balRows[0] ? Number((balRows[0] as any).balance) : creditMeowcoins;
      this.log.log(`Thunder credited: ref=${ref} steam=${steamId} transRef=${transRef} +${creditMeowcoins} meowcoins`);
      return { ref, status: 'credited', meowcoins: creditMeowcoins, balance };
    } catch (e) {
      try { await conn.rollback(); } catch { /* ignore */ }
      throw e;
    } finally {
      conn.release();
    }
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

  // ---- BuyMeACoffee manual claim (fallback when the webhook couldn't auto-attribute) --------

  /** POST /topup/bmc/claim — donor uploads proof; lands as 'pending' for an admin to review. */
  async createBmcClaim(user: JwtPayload, screenshotBase64: string, note?: string): Promise<BmcClaimView> {
    const { steamId } = await this.resolveIdentity(user);
    const result = await this.topupDb.query<mysql.RowDataPacket[]>(
      `INSERT INTO bmc_claims (steam_id, note, screenshot) VALUES (?, ?, ?)`,
      [steamId, note?.trim() || null, screenshotBase64],
    );
    const id = (result as any).insertId as number;
    const row = await this.topupDb.first<any>(`SELECT * FROM bmc_claims WHERE id = ?`, [id]);
    return this.toBmcClaimView(row);
  }

  /** GET /topup/bmc/claims — the current user's own claims, newest first (no screenshot payload). */
  async myBmcClaims(user: JwtPayload): Promise<BmcClaimView[]> {
    const { steamId } = await this.resolveIdentity(user);
    const rows = await this.topupDb.query<any>(
      `SELECT id, status, note, credited_meowcoins, admin_note, created_at, resolved_at
       FROM bmc_claims WHERE steam_id = ? ORDER BY id DESC LIMIT 20`,
      [steamId],
    );
    return rows.map((r: any) => this.toBmcClaimView(r));
  }

  private toBmcClaimView(r: any): BmcClaimView {
    return {
      id: Number(r.id),
      status: r.status,
      note: r.note,
      credited_meowcoins: r.credited_meowcoins !== null && r.credited_meowcoins !== undefined ? Number(r.credited_meowcoins) : null,
      admin_note: r.admin_note,
      created_at: r.created_at,
      resolved_at: r.resolved_at,
    };
  }

  /** GET /meowcoins/me — current Meowcoin balance (0 if no wallet row yet). */
  async meowcoinBalance(user: JwtPayload): Promise<MeowcoinBalanceView> {
    const { steamId } = await this.resolveIdentity(user);
    const row = await this.topupDb.first<{ balance: string }>(
      `SELECT balance FROM meow_coins WHERE steam_id = ?`, [steamId],
    );
    return { steam_id: steamId, balance: row ? Number(row.balance) : 0 };
  }

  // ---- Poller-facing helpers (Pi5 only) ------------------------------------

  /**
   * Oldest pending, not-yet-expired PLERNPAY top-ups (the poller polls these against PlernPay).
   * Thunder rows are NEVER polled — they are credited synchronously via /topup/thunder/verify.
   */
  async findPollable(limit: number): Promise<TopupRow[]> {
    return this.topupDb.query<TopupRow>(
      `SELECT * FROM topups
        WHERE status = 'pending' AND provider = 'plernpay'
          AND (expires_at IS NULL OR expires_at > NOW())
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
        `INSERT INTO meow_coins (steam_id, balance) VALUES (?, ?)
         ON DUPLICATE KEY UPDATE balance = balance + VALUES(balance)`,
        [row.steam_id, row.meowcoins],
      );
      await conn.query(
        `INSERT INTO meow_coin_log (steam_id, delta, reason, ref) VALUES (?, ?, 'topup', ?)`,
        [row.steam_id, row.meowcoins, row.ref],
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

  /**
   * Credits a BuyMeACoffee donation directly (no pending phase — BMC only webhooks us AFTER the
   * payment has cleared). `ref` is the idempotency key (`bmc_<event id>`); a duplicate webhook
   * delivery (BMC retries on a non-2xx response) is a no-op via the UNIQUE(ref) guard.
   * Counts toward the same monthly cap/tier pool as PromptPay donations (`baht` already converted
   * from USD by the caller) — BMC payments are not blocked by the cap since the money is already
   * received; the cap only gates NEW top-up creation via the other providers.
   */
  async creditBuyMeACoffee(ref: string, steamId: string, baht: number): Promise<BmcWebhookResult> {
    const meowcoins = Math.round(baht * this.meowcoinPerBaht());
    const conn = await this.topupDb.getConnection();
    try {
      await conn.beginTransaction();
      try {
        await conn.query(
          `INSERT INTO topups
             (ref, steam_id, discord_id, baht, unique_amount, meowcoins, status, provider, confirmed_at, credited_at)
           VALUES (?, ?, NULL, ?, ?, ?, 'credited', 'buymeacoffee', NOW(), NOW())`,
          [ref, steamId, baht, baht, meowcoins],
        );
      } catch (e: any) {
        await conn.rollback();
        if (e?.code === 'ER_DUP_ENTRY') {
          this.log.log(`BMC webhook ${ref} already credited — skipping duplicate delivery`);
          return { handled: false, reason: 'duplicate_event' };
        }
        throw e;
      }
      await conn.query(
        `INSERT INTO meow_coins (steam_id, balance) VALUES (?, ?)
         ON DUPLICATE KEY UPDATE balance = balance + VALUES(balance)`,
        [steamId, meowcoins],
      );
      await conn.query(
        `INSERT INTO meow_coin_log (steam_id, delta, reason, ref) VALUES (?, ?, 'topup_bmc', ?)`,
        [steamId, meowcoins, ref],
      );
      await conn.commit();
      this.log.log(`BMC credited: ref=${ref} steam=${steamId} baht=${baht} +${meowcoins} meowcoins`);
      return { handled: true, steam_id: steamId, baht };
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
      meowcoins: Number(r.meowcoins),
      expires_at: r.expires_at,
      credited_at: r.credited_at,
    };
  }

  /** Convert an ISO-ish gateway timestamp to a MySQL DATETIME string, or null. */
  // Formats an instant as a MySQL DATETIME string in the SERVER'S LOCAL time zone, to match the
  // rest of the topup tables (created_at/confirmed_at/credited_at use CURRENT_TIMESTAMP/NOW(),
  // which are local) and mysql2's default `timezone:'local'` on read-back. Storing expires_at in
  // the same zone is what lets the poller compare it with NOW() and lets the API serialise it to
  // the correct UTC ISO for the web. Do NOT store this in UTC: NOW() is local, so a UTC value
  // would look ~7h in the past on a UTC+7 host and expire the row instantly.
  private toMysqlDate(iso: string | null | undefined): string | null {
    if (!iso) return null;
    const d = new Date(iso);
    if (isNaN(d.getTime())) return null;
    const p = (n: number) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} `
      + `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
  }
}
