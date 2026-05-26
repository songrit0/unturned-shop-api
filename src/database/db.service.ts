import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as mysql from 'mysql2/promise';

@Injectable()
export class DbService implements OnModuleInit, OnModuleDestroy {
  private readonly log = new Logger(DbService.name);
  private pool!: mysql.Pool;

  constructor(private readonly cfg: ConfigService) {}

  async onModuleInit() {
    const db = this.cfg.get('db');
    this.pool = mysql.createPool({
      host: db.host, port: db.port, database: db.database,
      user: db.user, password: db.password,
      waitForConnections: true, connectionLimit: 10, charset: 'utf8mb4',
      namedPlaceholders: true,
      // Steam IDs are 17-digit BIGINTs that overflow JS Number. Return them (and other big ints) as strings.
      supportBigNumbers: true,
      bigNumberStrings: true,
    });
    // sanity ping
    try {
      const c = await this.pool.getConnection();
      await c.ping();
      c.release();
      this.log.log(`MySQL pool ready (${db.host}:${db.port}/${db.database})`);
    } catch (e: any) {
      this.log.error(`MySQL connect failed: ${e.message}`);
    }

    // Ensure api-owned schema (codes ownership table, not touched by bot/plugin)
    try {
      const owners = this.table('sv', 'code_owners');
      await this.query(
        `CREATE TABLE IF NOT EXISTS ${owners} (
          code_id INT UNSIGNED PRIMARY KEY,
          steam_id BIGINT UNSIGNED NOT NULL,
          created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
          INDEX idx_steam (steam_id)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
      );
    } catch (e: any) {
      this.log.warn(`code_owners ensure failed: ${e.message}`);
    }

    // Migration: supply/demand pricing columns on sv_market
    await this.ensureSupplyDemandColumns();
  }

  /** Idempotent migration — checks information_schema and adds missing columns one at a time. */
  private async ensureSupplyDemandColumns() {
    const dbName = this.cfg.get('db.database');
    const marketBare = (this.cfg.get('db.svPrefix') || 'sv_') + 'market';
    const required = [
      { col: 'base_price',   ddl: `ADD COLUMN \`base_price\` DOUBLE NOT NULL DEFAULT 0 AFTER \`price\`` },
      { col: 'target_stock', ddl: `ADD COLUMN \`target_stock\` INT NOT NULL DEFAULT 1 AFTER \`base_price\`` },
      { col: 'elasticity',   ddl: `ADD COLUMN \`elasticity\` DOUBLE NOT NULL DEFAULT 0.5 AFTER \`target_stock\`` },
    ];

    for (const r of required) {
      try {
        const exists = await this.first<{ c: number }>(
          `SELECT COUNT(*) AS c FROM information_schema.COLUMNS
           WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? AND COLUMN_NAME = ?`,
          [dbName, marketBare, r.col],
        );
        if (exists && Number(exists.c) > 0) continue;
        await this.query(`ALTER TABLE \`${marketBare}\` ${r.ddl}`);
        this.log.log(`Migration: added ${marketBare}.${r.col}`);
      } catch (e: any) {
        this.log.warn(`Migration ${r.col} failed: ${e.message}`);
      }
    }

    // Backfill anchor values once (only when base_price is still 0)
    try {
      await this.query(
        `UPDATE \`${marketBare}\` SET
           base_price = IF(base_price = 0, price, base_price),
           target_stock = IF(target_stock <= 1, GREATEST(amount, 1), target_stock),
           elasticity = IF(elasticity = 0, 0.5, elasticity)`,
      );
    } catch (e: any) {
      this.log.warn(`Backfill anchors failed: ${e.message}`);
    }
  }

  async onModuleDestroy() {
    await this.pool?.end();
  }

  table(kind: 'sv' | 'rc', name: string): string {
    const prefix = kind === 'sv'
      ? this.cfg.get('db.svPrefix')
      : this.cfg.get('db.rcPrefix');
    return `\`${prefix}${name}\``;
  }

  async query<T = any>(sql: string, params?: any): Promise<T[]> {
    const [rows] = await this.pool.query(sql, params);
    return rows as T[];
  }

  async first<T = any>(sql: string, params?: any): Promise<T | null> {
    const rows = await this.query<T>(sql, params);
    return rows[0] ?? null;
  }

  /** Get a raw pooled connection for transactional work. Caller must release(). */
  getConnection(): Promise<mysql.PoolConnection> {
    return this.pool.getConnection();
  }
}
