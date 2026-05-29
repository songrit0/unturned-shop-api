import { Injectable } from '@nestjs/common';
import { DbService } from '../database/db.service';

export interface LinkRow { steam_id: string; discord_id: string; linked_at: Date; }

@Injectable()
export class UsersService {
  constructor(private readonly db: DbService) {}

  /** Returns the linked steam_id for a discord_id, or null if not linked yet (or discordId is null). */
  async findSteamByDiscord(discordId: string | null): Promise<string | null> {
    if (!discordId) return null;
    const links = this.db.table('sv', 'links');
    const row = await this.db.first<LinkRow>(
      `SELECT steam_id FROM ${links} WHERE discord_id=:d LIMIT 1`,
      { d: discordId },
    );
    return row ? String(row.steam_id) : null;
  }

  /** Returns the linked discord_id for a steam_id, or null if not linked. Reverse of findSteamByDiscord. */
  async findDiscordBySteam(steamId: string): Promise<string | null> {
    const links = this.db.table('sv', 'links');
    const row = await this.db.first<LinkRow>(
      `SELECT discord_id FROM ${links} WHERE steam_id=:s LIMIT 1`,
      { s: steamId },
    );
    return row ? String(row.discord_id) : null;
  }

  /**
   * Cache the current Discord username + display name on the existing sv_links row.
   * No-op when the user hasn't linked yet (row insert is owned by the bot's /link flow).
   * Best-effort: swallows errors so a transient DB hiccup never blocks login.
   */
  async updateDiscordNames(
    discordId: string,
    username: string,
    globalName: string | null,
  ): Promise<void> {
    const links = this.db.table('sv', 'links');
    try {
      await this.db.query(
        `UPDATE ${links}
            SET discord_username = ?,
                discord_global_name = ?,
                discord_username_updated_at = NOW()
          WHERE discord_id = ?`,
        [username, globalName, discordId],
      );
    } catch {
      /* best-effort cache; ignore failures */
    }
  }
}
