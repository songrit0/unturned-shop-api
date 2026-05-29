import { Injectable, Logger } from '@nestjs/common';
import { randomBytes, scrypt as scryptCb, timingSafeEqual } from 'crypto';
import { promisify } from 'util';
import * as mysql from 'mysql2/promise';
import { DbService } from '../database/db.service';

const scrypt = promisify(scryptCb) as (pwd: string | Buffer, salt: Buffer, keylen: number) => Promise<Buffer>;

const SALT_BYTES = 16;
const HASH_BYTES = 64;
const MAX_FAILS = 5;
const LOCK_MINUTES = 15;

/** Result of a verify attempt — drives the controller's HTTP mapping. */
export type PinVerifyResult =
  | { ok: true }
  | { ok: false; reason: 'invalid' }
  | { ok: false; reason: 'locked'; retryAfterSec: number };

interface PinRow {
  steam_id: string;
  pin_hash: Buffer;
  pin_salt: Buffer;
  failed_attempts: number;
  locked_until: Date | string | null;
}

/**
 * Stores and verifies the web-login PIN (sv_web_pins). Hashing is node:crypto scrypt with a
 * per-row random salt — no external dependency. The 6-digit PIN's real protection is the
 * lockout (MAX_FAILS over LOCK_MINUTES); the hash protects the value at rest.
 */
@Injectable()
export class WebPinService {
  private readonly log = new Logger(WebPinService.name);

  constructor(private readonly db: DbService) {}

  private tbl() { return this.db.table('sv', 'web_pins'); }

  /** Hash + store the PIN for a steam_id, resetting any lockout. Idempotent upsert (PIN rotation). */
  async setPin(steamId: string, pin: string): Promise<void> {
    const salt = randomBytes(SALT_BYTES);
    const hash = await scrypt(pin, salt, HASH_BYTES);
    await this.db.query(
      `INSERT INTO ${this.tbl()} (steam_id, pin_hash, pin_salt, failed_attempts, locked_until)
       VALUES (?, ?, ?, 0, NULL)
       ON DUPLICATE KEY UPDATE
         pin_hash = VALUES(pin_hash),
         pin_salt = VALUES(pin_salt),
         failed_attempts = 0,
         locked_until = NULL`,
      [steamId, hash, salt],
    );
  }

  /**
   * Verify a PIN. Anti-enumeration: an unknown steam_id and a wrong PIN both yield
   * { ok:false, reason:'invalid' } (indistinguishable to the caller). A live lockout yields
   * { ok:false, reason:'locked', retryAfterSec }. Success resets the counter.
   */
  async verify(steamId: string, pin: string): Promise<PinVerifyResult> {
    const row = await this.db.first<PinRow>(
      `SELECT steam_id, pin_hash, pin_salt, failed_attempts, locked_until
         FROM ${this.tbl()} WHERE steam_id = ?`,
      [steamId],
    );
    // No PIN set for this steam — treat as invalid (don't reveal existence).
    if (!row) return { ok: false, reason: 'invalid' };

    // Active lockout?
    if (row.locked_until != null) {
      const until = new Date(row.locked_until as any).getTime();
      const now = Date.now();
      if (until > now) {
        return { ok: false, reason: 'locked', retryAfterSec: Math.ceil((until - now) / 1000) };
      }
    }

    const candidate = await scrypt(pin, row.pin_salt, row.pin_hash.length);
    const match = candidate.length === row.pin_hash.length && timingSafeEqual(candidate, row.pin_hash);

    if (match) {
      // Reset counters on success.
      await this.db.query(
        `UPDATE ${this.tbl()} SET failed_attempts = 0, locked_until = NULL WHERE steam_id = ?`,
        [steamId],
      );
      return { ok: true };
    }

    // Failed: atomic increment; lock for LOCK_MINUTES once we reach MAX_FAILS.
    await this.db.query(
      `UPDATE ${this.tbl()}
          SET failed_attempts = failed_attempts + 1,
              locked_until = IF(failed_attempts + 1 >= ?, NOW() + INTERVAL ? MINUTE, locked_until)
        WHERE steam_id = ?`,
      [MAX_FAILS, LOCK_MINUTES, steamId],
    );
    return { ok: false, reason: 'invalid' };
  }
}
