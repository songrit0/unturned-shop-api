import { Injectable } from '@nestjs/common';
import { DbService } from '../database/db.service';

export interface LinkRow { steam_id: string; discord_id: string; linked_at: Date; }

@Injectable()
export class UsersService {
  constructor(private readonly db: DbService) {}

  /** Returns the linked steam_id for a discord_id, or null if not linked yet. */
  async findSteamByDiscord(discordId: string): Promise<string | null> {
    const links = this.db.table('sv', 'links');
    const row = await this.db.first<LinkRow>(
      `SELECT steam_id FROM ${links} WHERE discord_id=:d LIMIT 1`,
      { d: discordId },
    );
    return row ? String(row.steam_id) : null;
  }
}
