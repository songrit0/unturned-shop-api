import { BadRequestException, Injectable } from '@nestjs/common';
import * as mysql from 'mysql2/promise';
import { TopupDbService } from './topup-db.service';

/**
 * Reusable Meowcoin wallet debit/refund helper, used by the shop basket + VIP buy
 * to charge Meowcoin for purchases. The wallet (meow_coins) + log (meow_coin_log)
 * live in the SEPARATE Pi5-local MariaDB (TopupDbService) — NEVER the shop DB.
 *
 * Because the wallet and the shop ledger are in two different databases there can
 * be no shared transaction; callers run a SAGA: keep their shop-DB txn open, debit
 * here, commit the shop txn, and refund() here if the shop commit fails.
 */
@Injectable()
export class MeowcoinWalletService {
  constructor(private readonly topupDb: TopupDbService) {}

  /**
   * Atomically deduct `amount` Meowcoin from a wallet, then log delta = -amount.
   * Throws BadRequestException('insufficient_meowcoin') if the balance is too low
   * (the guarded UPDATE affects 0 rows). Pass an existing Pi5 `conn` to run inside
   * a caller-owned transaction; otherwise a pooled connection is used per-statement.
   */
  async debit(
    steamId: string,
    amount: number,
    reason: string,
    ref?: string | null,
    conn?: mysql.PoolConnection,
  ): Promise<void> {
    const amt = Math.trunc(Number(amount));
    if (!Number.isFinite(amt) || amt <= 0) {
      throw new BadRequestException('invalid_meowcoin_amount');
    }

    // Run a statement either on the caller's transactional connection or the pool.
    // conn.query() returns [rows, fields]; topupDb.query() returns rows.
    const run = conn
      ? async (sql: string, params: any[]) => (await conn.query(sql, params))[0]
      : (sql: string, params: any[]) => this.topupDb.query(sql, params);

    // Ensure a wallet row exists so the guarded UPDATE below is the only gate.
    await run(
      `INSERT INTO meow_coins (steam_id, balance) VALUES (?, 0)
       ON DUPLICATE KEY UPDATE balance = balance`,
      [steamId],
    );

    // Atomic guard: only succeeds when the wallet has enough.
    const res: any = await run(
      `UPDATE meow_coins SET balance = balance - ? WHERE steam_id = ? AND balance >= ?`,
      [amt, steamId, amt],
    );
    const affected = Number(res?.affectedRows ?? 0);
    if (affected === 0) {
      throw new BadRequestException('insufficient_meowcoin');
    }

    await run(
      `INSERT INTO meow_coin_log (steam_id, delta, reason, ref, actor) VALUES (?, ?, ?, ?, 'web')`,
      [steamId, -amt, reason, ref ?? null],
    );
  }

  /**
   * Credit `amount` Meowcoin back to a wallet (compensation for a failed SAGA),
   * logging delta = +amount. Never throws on "insufficient" (it only adds).
   */
  async refund(
    steamId: string,
    amount: number,
    reason: string,
    ref?: string | null,
  ): Promise<void> {
    const amt = Math.trunc(Number(amount));
    if (!Number.isFinite(amt) || amt <= 0) return;
    await this.topupDb.query(
      `INSERT INTO meow_coins (steam_id, balance) VALUES (?, ?)
       ON DUPLICATE KEY UPDATE balance = balance + VALUES(balance)`,
      [steamId, amt],
    );
    await this.topupDb.query(
      `INSERT INTO meow_coin_log (steam_id, delta, reason, ref, actor) VALUES (?, ?, ?, ?, 'web')`,
      [steamId, amt, reason, ref ?? null],
    );
  }

  /** Current Meowcoin balance (0 if no wallet row yet). */
  async balanceOf(steamId: string): Promise<number> {
    const row = await this.topupDb.first<{ balance: string }>(
      `SELECT balance FROM meow_coins WHERE steam_id = ?`,
      [steamId],
    );
    return row ? Number(row.balance) : 0;
  }
}
