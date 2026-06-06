import { Injectable, NotFoundException } from '@nestjs/common';
import { DbService } from '../database/db.service';

export interface PlayerStatsEntry {
  steamId: string;
  name: string;
  kills: number;
  headshots: number;
  pvpDeaths: number;
  pveDeaths: number;
  zombies: number;
  megaZombies: number;
  animals: number;
  resources: number;
  harvests: number;
  fish: number;
  structures: number;
  barricades: number;
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
      `SELECT SteamId, Name, Kills, Headshots, PVPDeaths, PVEDeaths,
              Zombies, MegaZombies, Animals, Resources, Harvests, Fish,
              Structures, Barricades, Playtime,
              ROUND(Kills / (PVPDeaths + 1), 2) AS KDRatio
       FROM ${table}
       WHERE UIDisabled IS NULL OR UIDisabled = 0
       ORDER BY Kills DESC
       LIMIT ?`,
      [n],
    );
    return rows.map((r) => this.mapRow(r));
  }

  async findBySteamId(steamId: string): Promise<PlayerStatsEntry> {
    const table = this.db.tableRaw('PlayerStats');
    const row = await this.db.first<any>(
      `SELECT SteamId, Name, Kills, Headshots, PVPDeaths, PVEDeaths,
              Zombies, MegaZombies, Animals, Resources, Harvests, Fish,
              Structures, Barricades, Playtime,
              ROUND(Kills / (PVPDeaths + 1), 2) AS KDRatio
       FROM ${table}
       WHERE SteamId = ?`,
      [steamId],
    );
    if (!row) throw new NotFoundException('player_not_found');
    return this.mapRow(row);
  }

  private mapRow(r: any): PlayerStatsEntry {
    return {
      steamId: String(r.SteamId),
      name: r.Name ?? 'Unknown',
      kills: Number(r.Kills),
      headshots: Number(r.Headshots),
      pvpDeaths: Number(r.PVPDeaths),
      pveDeaths: Number(r.PVEDeaths),
      zombies: Number(r.Zombies),
      megaZombies: Number(r.MegaZombies),
      animals: Number(r.Animals),
      resources: Number(r.Resources),
      harvests: Number(r.Harvests),
      fish: Number(r.Fish),
      structures: Number(r.Structures),
      barricades: Number(r.Barricades),
      playtime: Number(r.Playtime),
      kdRatio: Number(r.KDRatio),
    };
  }
}
