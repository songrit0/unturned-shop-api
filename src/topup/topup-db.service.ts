import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as mysql from 'mysql2/promise';

/**
 * SECOND, Pi5-local MariaDB pool — completely separate from the external shop DB (DbService).
 * Owns the Vcoin wallet + real-money top-up records. NOTHING in here ever touches the shop DB.
 *
 * On boot it creates its schema idempotently (CREATE TABLE IF NOT EXISTS).
 */
@Injectable()
export class TopupDbService implements OnModuleInit, OnModuleDestroy {
  private readonly log = new Logger(TopupDbService.name);
  private pool!: mysql.Pool;

  constructor(private readonly cfg: ConfigService) {}

  async onModuleInit() {
    const db = this.cfg.get<{ host: string; port: number; user: string; password: string; database: string }>('topupDb')!;
    this.pool = mysql.createPool({
      host: db.host, port: db.port, database: db.database,
      user: db.user, password: db.password,
      waitForConnections: true, connectionLimit: 5, charset: 'utf8mb4',
      // Steam IDs are 17-digit BIGINTs that overflow JS Number — return big ints as strings.
      supportBigNumbers: true,
      bigNumberStrings: true,
      enableKeepAlive: true,
      keepAliveInitialDelay: 10000,
      connectTimeout: 20000,
    });

    try {
      const c = await this.pool.getConnection();
      await c.ping();
      c.release();
      this.log.log(`Top-up MariaDB pool ready (${db.host}:${db.port}/${db.database})`);
    } catch (e: any) {
      this.log.error(`Top-up DB connect failed: ${e.message}`);
    }

    await this.ensureSchema();
  }

  private async ensureSchema() {
    try {
      await this.query(
        `CREATE TABLE IF NOT EXISTS v_coins (
          steam_id BIGINT UNSIGNED PRIMARY KEY,
          balance BIGINT NOT NULL DEFAULT 0,
          updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
      );
      await this.query(
        `CREATE TABLE IF NOT EXISTS topups (
          id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
          ref VARCHAR(64) NOT NULL,
          steam_id BIGINT UNSIGNED NOT NULL,
          discord_id BIGINT UNSIGNED NULL,
          baht DECIMAL(10,2) NOT NULL,
          unique_amount DECIMAL(10,2) NOT NULL,
          vcoins BIGINT NOT NULL,
          qr_code TEXT NULL,
          promptpay_id VARCHAR(32) NULL,
          status ENUM('pending','confirmed','credited','expired','cancelled','failed') NOT NULL DEFAULT 'pending',
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          expires_at DATETIME NULL,
          confirmed_at DATETIME NULL,
          credited_at DATETIME NULL,
          PRIMARY KEY (id),
          UNIQUE KEY uq_ref (ref),
          INDEX idx_steam (steam_id),
          INDEX idx_status (status)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
      );
      await this.query(
        `CREATE TABLE IF NOT EXISTS v_coin_log (
          id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
          steam_id BIGINT UNSIGNED NOT NULL,
          delta BIGINT NOT NULL,
          reason VARCHAR(32) NOT NULL,
          ref VARCHAR(64) NULL,
          at DATETIME DEFAULT CURRENT_TIMESTAMP,
          PRIMARY KEY (id),
          INDEX idx_steam (steam_id)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
      );
      // Idempotent migration: v_coin_log.actor (who performed an admin adjustment).
      await this.ensureColumn('v_coin_log', 'actor', `ADD COLUMN \`actor\` VARCHAR(64) NULL`);

      // Multi-provider migration: which gateway minted the row + the verified bank transRef.
      await this.ensureColumn('topups', 'provider', `ADD COLUMN \`provider\` VARCHAR(16) NOT NULL DEFAULT 'plernpay'`);
      await this.ensureColumn('topups', 'trans_ref', `ADD COLUMN \`trans_ref\` VARCHAR(64) NULL`);
      // UNIQUE so the same verified bank slip (transRef) can never be credited twice.
      await this.ensureUniqueIndex('topups', 'uq_trans_ref', 'trans_ref');

      // Provider registry (admin on/off toggle).
      await this.query(
        `CREATE TABLE IF NOT EXISTS topup_providers (
          \`key\` VARCHAR(16) PRIMARY KEY,
          label VARCHAR(64) NULL,
          enabled TINYINT(1) NOT NULL DEFAULT 1,
          sort INT NOT NULL DEFAULT 0
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
      );
      await this.seedProviders();

      this.log.log('Top-up schema ready (v_coins / topups / v_coin_log / topup_providers)');
    } catch (e: any) {
      this.log.error(`Top-up schema ensure failed: ${e.message}`);
    }
  }

  /** Seed the provider registry once, only when the table is empty. */
  private async seedProviders() {
    try {
      const cnt = await this.first<{ c: number }>(`SELECT COUNT(*) AS c FROM topup_providers`);
      if (cnt && Number(cnt.c) > 0) return;
      await this.query(
        `INSERT INTO topup_providers (\`key\`, label, enabled, sort) VALUES
           ('plernpay', 'PlernPay (PromptPay auto)', 1, 1),
           ('thunder',  'Thunder (slip upload)',     1, 2)`,
      );
      this.log.log('Top-up providers seeded (plernpay, thunder)');
    } catch (e: any) {
      this.log.warn(`Top-up provider seed failed: ${e.message}`);
    }
  }

  /** Add a UNIQUE index only if it doesn't already exist (information_schema-guarded, idempotent). */
  private async ensureUniqueIndex(table: string, indexName: string, column: string) {
    const dbName = this.cfg.get<string>('topupDb.database');
    try {
      const exists = await this.first<{ c: number }>(
        `SELECT COUNT(*) AS c FROM information_schema.STATISTICS
         WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? AND INDEX_NAME = ?`,
        [dbName, table, indexName],
      );
      if (exists && Number(exists.c) > 0) return;
      await this.query(`ALTER TABLE \`${table}\` ADD UNIQUE INDEX \`${indexName}\` (\`${column}\`)`);
      this.log.log(`Top-up migration: added UNIQUE index ${table}.${indexName}`);
    } catch (e: any) {
      this.log.warn(`Top-up migration index ${table}.${indexName} failed: ${e.message}`);
    }
  }

  /** Add a column only if it doesn't already exist (information_schema-guarded, idempotent). */
  private async ensureColumn(table: string, column: string, ddl: string) {
    const dbName = this.cfg.get<string>('topupDb.database');
    try {
      const exists = await this.first<{ c: number }>(
        `SELECT COUNT(*) AS c FROM information_schema.COLUMNS
         WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? AND COLUMN_NAME = ?`,
        [dbName, table, column],
      );
      if (exists && Number(exists.c) > 0) return;
      await this.query(`ALTER TABLE \`${table}\` ${ddl}`);
      this.log.log(`Top-up migration: added ${table}.${column}`);
    } catch (e: any) {
      this.log.warn(`Top-up migration ${table}.${column} failed: ${e.message}`);
    }
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

  async onModuleDestroy() {
    await this.pool?.end();
  }
}
