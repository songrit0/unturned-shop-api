import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as mysql from 'mysql2/promise';

/**
 * SECOND, Pi5-local MariaDB pool — completely separate from the external shop DB (DbService).
 * Owns the Meowcoin wallet + real-money top-up records. NOTHING in here ever touches the shop DB.
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
      // Vcoin -> Meowcoin rename migration. These run FIRST (before the CREATE IF NOT EXISTS
      // below) so existing installs keep their data: the tables/column are renamed in place,
      // then the CREATE statements become a no-op. Fresh installs skip the renames (old names
      // absent) and get the new names straight from CREATE. Guarded + idempotent.
      await this.ensureRenameTable('v_coins', 'meow_coins');
      await this.ensureRenameTable('v_coin_log', 'meow_coin_log');
      await this.ensureRenameColumn('topups', 'vcoins', 'meowcoins', 'BIGINT NOT NULL');

      await this.query(
        `CREATE TABLE IF NOT EXISTS meow_coins (
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
          meowcoins BIGINT NOT NULL,
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
        `CREATE TABLE IF NOT EXISTS meow_coin_log (
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
      // Idempotent migration: meow_coin_log.actor (who performed an admin adjustment).
      await this.ensureColumn('meow_coin_log', 'actor', `ADD COLUMN \`actor\` VARCHAR(64) NULL`);

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

      // Manual fallback for BuyMeACoffee donations the webhook couldn't auto-attribute (no/typo'd
      // steamID64 in the message). User uploads a screenshot as proof; an admin reviews it and
      // credits Meowcoins manually via the existing /admin/meowcoins/adjust path.
      await this.query(
        `CREATE TABLE IF NOT EXISTS bmc_claims (
          id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
          steam_id BIGINT UNSIGNED NOT NULL,
          note VARCHAR(255) NULL,
          screenshot LONGTEXT NOT NULL,
          status ENUM('pending','approved','rejected') NOT NULL DEFAULT 'pending',
          credited_meowcoins BIGINT NULL,
          admin_note VARCHAR(255) NULL,
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          resolved_at DATETIME NULL,
          PRIMARY KEY (id),
          INDEX idx_steam (steam_id),
          INDEX idx_status (status)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
      );

      // ---- Donate / Battlepass tables (Pi5-local, API-owned) ----
      // Seasonal donation tiers (battlepass): a cumulative monthly donation total unlocks a tier;
      // its reward item-set is delivered as a redeem code the user claims manually. Tiers + claims
      // reset each calendar month (the period column scopes claims).
      await this.query(
        `CREATE TABLE IF NOT EXISTS donation_tiers (
          id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
          threshold_baht INT NOT NULL,
          name VARCHAR(64) NOT NULL,
          enabled TINYINT(1) NOT NULL DEFAULT 1,
          sort INT NOT NULL DEFAULT 0,
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          PRIMARY KEY (id)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
      );
      await this.query(
        `CREATE TABLE IF NOT EXISTS donation_tier_rewards (
          id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
          tier_id BIGINT UNSIGNED NOT NULL,
          kind TINYINT NOT NULL DEFAULT 0,
          item_id INT NOT NULL,
          amount INT NOT NULL DEFAULT 1,
          quality INT NOT NULL DEFAULT 100,
          PRIMARY KEY (id),
          INDEX idx_tier (tier_id)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
      );
      await this.query(
        `CREATE TABLE IF NOT EXISTS donation_claims (
          id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
          steam_id BIGINT UNSIGNED NOT NULL,
          tier_id BIGINT UNSIGNED NOT NULL,
          period CHAR(7) NOT NULL,
          code VARCHAR(64) NULL,
          claimed_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          PRIMARY KEY (id),
          UNIQUE KEY uq_claim (steam_id, tier_id, period),
          INDEX idx_steam (steam_id)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
      );

      this.log.log('Top-up schema ready (meow_coins / topups / meow_coin_log / topup_providers / donation_tiers / donation_tier_rewards / donation_claims)');
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

  /**
   * Rename a table only when the OLD name exists AND the NEW name does not yet exist in this
   * schema (information_schema-guarded, idempotent). Safe to run on every boot.
   */
  private async ensureRenameTable(oldName: string, newName: string) {
    const dbName = this.cfg.get<string>('topupDb.database');
    try {
      const oldExists = await this.first<{ c: number }>(
        `SELECT COUNT(*) AS c FROM information_schema.TABLES
         WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ?`,
        [dbName, oldName],
      );
      const newExists = await this.first<{ c: number }>(
        `SELECT COUNT(*) AS c FROM information_schema.TABLES
         WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ?`,
        [dbName, newName],
      );
      if (!oldExists || Number(oldExists.c) === 0) return; // nothing to rename
      if (newExists && Number(newExists.c) > 0) return;     // already migrated
      await this.query(`RENAME TABLE \`${oldName}\` TO \`${newName}\``);
      this.log.log(`Top-up migration: renamed table ${oldName} -> ${newName}`);
    } catch (e: any) {
      this.log.warn(`Top-up migration rename table ${oldName} -> ${newName} failed: ${e.message}`);
    }
  }

  /**
   * Rename a column only when the OLD column exists AND the NEW column does not yet exist on the
   * table (information_schema-guarded, idempotent). colDef must restate the full column type.
   */
  private async ensureRenameColumn(table: string, oldCol: string, newCol: string, colDef: string) {
    const dbName = this.cfg.get<string>('topupDb.database');
    try {
      const oldExists = await this.first<{ c: number }>(
        `SELECT COUNT(*) AS c FROM information_schema.COLUMNS
         WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? AND COLUMN_NAME = ?`,
        [dbName, table, oldCol],
      );
      const newExists = await this.first<{ c: number }>(
        `SELECT COUNT(*) AS c FROM information_schema.COLUMNS
         WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? AND COLUMN_NAME = ?`,
        [dbName, table, newCol],
      );
      if (!oldExists || Number(oldExists.c) === 0) return; // nothing to rename
      if (newExists && Number(newExists.c) > 0) return;     // already migrated
      await this.query(`ALTER TABLE \`${table}\` CHANGE \`${oldCol}\` \`${newCol}\` ${colDef}`);
      this.log.log(`Top-up migration: renamed column ${table}.${oldCol} -> ${table}.${newCol}`);
    } catch (e: any) {
      this.log.warn(`Top-up migration rename column ${table}.${oldCol} -> ${newCol} failed: ${e.message}`);
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
