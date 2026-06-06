import { Injectable } from '@nestjs/common';
import { DbService } from '../database/db.service';

export interface PlayerStatsEntry {
  steamId: string;
  name: string;
  kills: number;
  headshots: number;
  pvpDeaths: number;
  pveDeaths: number;
  zombies: number;
  playtime: number;
  kdRatio: number;
}

@Injectable()
export class PlayerStatsService {
  constructor(private readonly db: DbService) {}

  async leaderboard(limit: number): Promise<PlayerStatsEntry[]> {
    const table = this.db.tableRaw('PlayerStats');
    const n = Math.min(Math.max(1, limit), 100);
    const rows = await this.db.query<any>(
      `SELECT SteamId, Name, Kills, Headshots, PVPDeaths, PVEDeaths, Zombies, Playtime,
              ROUND(Kills / (PVPDeaths + 1), 2) AS KDRatio
       FROM ${table}
       WHERE UIDisabled IS NULL OR UIDisabled = 0
       ORDER BY Kills DESC
       LIMIT ?`,
      [n],
    );
    return rows.map((r) => ({
      steamId: String(r.SteamId),
      name: r.Name ?? 'Unknown',
      kills: Number(r.Kills),
      headshots: Number(r.Headshots),
      pvpDeaths: Number(r.PVPDeaths),
      pveDeaths: Number(r.PVEDeaths),
      zombies: Number(r.Zombies),
      playtime: Number(r.Playtime),
      kdRatio: Number(r.KDRatio),
    }));
  }
}
