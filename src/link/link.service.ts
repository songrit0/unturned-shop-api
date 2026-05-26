import { Injectable } from '@nestjs/common';
import { randomBytes } from 'crypto';
import { DbService } from '../database/db.service';
import { UsersService } from '../users/users.service';

const CODE_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';

@Injectable()
export class LinkService {
  constructor(private readonly db: DbService, private readonly users: UsersService) {}

  private genCode(n = 8): string {
    const buf = randomBytes(n);
    let s = '';
    for (let i = 0; i < n; i++) s += CODE_ALPHABET[buf[i] % CODE_ALPHABET.length];
    return s;
  }

  /**
   * Issue a one-time link code for this Discord user.
   * - If already linked → returns { alreadyLinked: true, steamId }
   * - Otherwise → upsert (delete prior code for this discord_id, insert new one) and return the code
   */
  async createWelcomeCode(discordId: string): Promise<
    { alreadyLinked: true; steamId: string } | { alreadyLinked: false; code: string }
  > {
    const linked = await this.users.findSteamByDiscord(discordId);
    if (linked) return { alreadyLinked: true, steamId: linked };

    const codes = this.db.table('sv', 'link_codes');
    const code = this.genCode(8);

    await this.db.query(`DELETE FROM ${codes} WHERE discord_id = ?`, [discordId]);
    await this.db.query(
      `INSERT INTO ${codes} (code, discord_id) VALUES (?, ?)`,
      [code, discordId],
    );

    return { alreadyLinked: false, code };
  }
}
