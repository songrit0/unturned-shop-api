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

    // Quest system tables
    await this.ensureQuestTables();

    // Master items refactor: sv_items + lean sv_market
    await this.ensureMasterItems();

    // Price history (candle chart source)
    await this.ensurePriceHistory();
  }

  private async ensurePriceHistory() {
    const history = this.table('sv', 'market_price_history');
    try {
      await this.query(
        `CREATE TABLE IF NOT EXISTS ${history} (
          id BIGINT AUTO_INCREMENT PRIMARY KEY,
          item_id INT UNSIGNED NOT NULL,
          price DOUBLE NOT NULL,
          amount INT NOT NULL,
          snapshot_at DATETIME NOT NULL,
          INDEX idx_item_time (item_id, snapshot_at),
          INDEX idx_snapshot_at (snapshot_at)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
      );
    } catch (e: any) {
      this.log.warn(`market_price_history ensure failed: ${e.message}`);
    }
  }

  private async ensureMasterItems() {
    const prefix = this.cfg.get('db.svPrefix') || 'sv_';
    const dbName = this.cfg.get('db.database');
    const items = `\`${prefix}items\``;
    const market = `\`${prefix}market\``;
    const questItems = `\`${prefix}quest_items\``;
    const itemTypes = `\`${prefix}item_types\``;
    const itemsBare = `${prefix}items`;
    const marketBare = `${prefix}market`;
    const questItemsBare = `${prefix}quest_items`;
    const itemTypesBare = `${prefix}item_types`;

    // 1) CREATE TABLE sv_items
    try {
      await this.query(
        `CREATE TABLE IF NOT EXISTS ${items} (
          id INT UNSIGNED PRIMARY KEY,
          name VARCHAR(64) NOT NULL,
          description VARCHAR(512) NULL,
          image_url VARCHAR(512) NULL,
          type_id INT NULL,
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
          INDEX idx_items_type (type_id)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
      );
    } catch (e: any) {
      this.log.warn(`items ensure failed: ${e.message}`);
    }

    // 2) Backfill — only when sv_items is empty AND sv_market still has the legacy columns
    try {
      const countRow = await this.first<{ c: number }>(`SELECT COUNT(*) AS c FROM ${items}`);
      const itemsCount = Number(countRow?.c || 0);
      if (itemsCount === 0) {
        const cols = await this.query<{ COLUMN_NAME: string }>(
          `SELECT COLUMN_NAME FROM information_schema.COLUMNS
           WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? AND COLUMN_NAME IN ('name','image_url','type_id')`,
          [dbName, marketBare],
        );
        const have = new Set(cols.map((c) => c.COLUMN_NAME));
        if (have.has('name')) {
          const nameCol = '`name`';
          const imageExpr = have.has('image_url') ? '`image_url`' : 'NULL';
          const typeExpr = have.has('type_id') ? '`type_id`' : 'NULL';
          const res: any = await this.query(
            `INSERT IGNORE INTO ${items} (id, name, image_url, type_id)
             SELECT \`item_id\`, ${nameCol}, ${imageExpr}, ${typeExpr} FROM ${market}`,
          );
          const affected = Number(res?.affectedRows || 0);
          this.log.log(`Master items: backfilled ${affected} row(s) from ${marketBare} into ${itemsBare}`);
        } else {
          this.log.log(`Master items: skip backfill — ${marketBare}.name not present`);
        }
      } else {
        this.log.log(`Master items: skip backfill — ${itemsBare} already has ${itemsCount} row(s)`);
      }
    } catch (e: any) {
      this.log.warn(`Master items backfill failed: ${e.message}`);
    }

    // 3) DROP legacy columns from sv_market — GATED by env SHOP_API_DROP_LEGACY_MARKET_COLS=1
    const dropGate = (process.env.SHOP_API_DROP_LEGACY_MARKET_COLS || '').trim();
    if (dropGate === '1') {
      for (const col of ['name', 'image_url', 'type_id']) {
        try {
          const exists = await this.first<{ c: number }>(
            `SELECT COUNT(*) AS c FROM information_schema.COLUMNS
             WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? AND COLUMN_NAME = ?`,
            [dbName, marketBare, col],
          );
          if (!exists || Number(exists.c) === 0) continue;
          await this.query(`ALTER TABLE ${market} DROP COLUMN \`${col}\``);
          this.log.log(`Master items: dropped legacy column ${marketBare}.${col}`);
        } catch (e: any) {
          this.log.warn(`Master items: drop ${marketBare}.${col} failed: ${e.message}`);
        }
      }
    } else {
      this.log.log(
        `Master items: legacy columns retained — set SHOP_API_DROP_LEGACY_MARKET_COLS=1 to drop after verifying backfill`,
      );
    }

    // 4) Foreign keys — each guarded by information_schema, with orphan-row checks for refs to sv_items
    await this.ensureForeignKey({
      table: marketBare,
      name: 'fk_market_item',
      ddl: `ADD CONSTRAINT \`fk_market_item\` FOREIGN KEY (\`item_id\`) REFERENCES ${items}(\`id\`)`,
      orphanSql:
        `SELECT m.\`item_id\` AS id FROM ${market} m
         LEFT JOIN ${items} i ON i.\`id\` = m.\`item_id\`
         WHERE i.\`id\` IS NULL LIMIT 50`,
      orphanLabel: 'sv_market.item_id has no matching sv_items.id',
      dbName,
    });

    await this.ensureForeignKey({
      table: questItemsBare,
      name: 'fk_qitems_item',
      ddl: `ADD CONSTRAINT \`fk_qitems_item\` FOREIGN KEY (\`item_id\`) REFERENCES ${items}(\`id\`)`,
      orphanSql:
        `SELECT q.\`quest_id\`, q.\`item_id\` AS id FROM ${questItems} q
         LEFT JOIN ${items} i ON i.\`id\` = q.\`item_id\`
         WHERE i.\`id\` IS NULL LIMIT 50`,
      orphanLabel: 'sv_quest_items.item_id has no matching sv_items.id',
      dbName,
    });

    await this.ensureForeignKey({
      table: itemsBare,
      name: 'fk_items_type',
      ddl: `ADD CONSTRAINT \`fk_items_type\` FOREIGN KEY (\`type_id\`) REFERENCES ${itemTypes}(\`id\`) ON DELETE SET NULL`,
      orphanSql:
        `SELECT i.\`id\` FROM ${items} i
         LEFT JOIN ${itemTypes} t ON t.\`id\` = i.\`type_id\`
         WHERE i.\`type_id\` IS NOT NULL AND t.\`id\` IS NULL LIMIT 50`,
      orphanLabel: `${itemsBare}.type_id has no matching ${itemTypesBare}.id`,
      dbName,
    });
  }

  private async ensureForeignKey(opts: {
    table: string;
    name: string;
    ddl: string;
    orphanSql: string;
    orphanLabel: string;
    dbName: string;
  }) {
    try {
      const existing = await this.first<{ c: number }>(
        `SELECT COUNT(*) AS c FROM information_schema.TABLE_CONSTRAINTS
         WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? AND CONSTRAINT_NAME = ?
           AND CONSTRAINT_TYPE = 'FOREIGN KEY'`,
        [opts.dbName, opts.table, opts.name],
      );
      if (existing && Number(existing.c) > 0) return;

      const orphans = await this.query<any>(opts.orphanSql);
      if (orphans.length > 0) {
        const sample = orphans.map((o) => JSON.stringify(o)).join(', ');
        this.log.warn(
          `Master items: SKIP FK ${opts.name} on ${opts.table} — ${orphans.length} orphan row(s): ${opts.orphanLabel}. Sample: ${sample}`,
        );
        return;
      }

      await this.query(`ALTER TABLE \`${opts.table}\` ${opts.ddl}`);
      this.log.log(`Master items: added FK ${opts.name} on ${opts.table}`);
    } catch (e: any) {
      this.log.warn(`Master items: FK ${opts.name} failed: ${e.message}`);
    }
  }

  private async ensureQuestTables() {
    const prefix = this.cfg.get('db.svPrefix') || 'sv_';
    const itemTypes = `\`${prefix}item_types\``;
    const market = `\`${prefix}market\``;
    const quests = `\`${prefix}quests\``;
    const questItems = `\`${prefix}quest_items\``;
    const questProgress = `\`${prefix}quest_progress\``;
    const questCompletions = `\`${prefix}quest_completions\``;
    const dbName = this.cfg.get('db.database');

    try {
      await this.query(
        `CREATE TABLE IF NOT EXISTS ${itemTypes} (
          id INT AUTO_INCREMENT PRIMARY KEY,
          name VARCHAR(64) NOT NULL UNIQUE,
          description VARCHAR(255) NULL,
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
      );
    } catch (e: any) {
      this.log.warn(`item_types ensure failed: ${e.message}`);
    }

    // ALTER sv_market ADD type_id (idempotent via information_schema check)
    try {
      const exists = await this.first<{ c: number }>(
        `SELECT COUNT(*) AS c FROM information_schema.COLUMNS
         WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? AND COLUMN_NAME = ?`,
        [dbName, `${prefix}market`, 'type_id'],
      );
      if (!exists || Number(exists.c) === 0) {
        await this.query(`ALTER TABLE ${market} ADD COLUMN \`type_id\` INT NULL`);
        this.log.log(`Migration: added ${prefix}market.type_id`);
      }
    } catch (e: any) {
      this.log.warn(`Migration market.type_id failed: ${e.message}`);
    }

    try {
      await this.query(
        `CREATE TABLE IF NOT EXISTS ${quests} (
          id INT AUTO_INCREMENT PRIMARY KEY,
          name VARCHAR(128) NOT NULL,
          description VARCHAR(512) NULL,
          reward_coins BIGINT NOT NULL DEFAULT 0,
          reset_type ENUM('once','daily','weekly') NOT NULL DEFAULT 'daily',
          enabled TINYINT(1) NOT NULL DEFAULT 1,
          start_at DATETIME NULL,
          end_at DATETIME NULL,
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
      );
    } catch (e: any) {
      this.log.warn(`quests ensure failed: ${e.message}`);
    }

    try {
      await this.query(
        `CREATE TABLE IF NOT EXISTS ${questItems} (
          quest_id INT NOT NULL,
          item_id INT UNSIGNED NOT NULL,
          qty_required INT UNSIGNED NOT NULL,
          PRIMARY KEY (quest_id, item_id),
          FOREIGN KEY (quest_id) REFERENCES ${quests}(id) ON DELETE CASCADE
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
      );
    } catch (e: any) {
      this.log.warn(`quest_items ensure failed: ${e.message}`);
    }

    try {
      await this.query(
        `CREATE TABLE IF NOT EXISTS ${questProgress} (
          quest_id INT NOT NULL,
          steam_id BIGINT UNSIGNED NOT NULL,
          item_id INT UNSIGNED NOT NULL,
          period_key VARCHAR(16) NOT NULL,
          sold_qty INT UNSIGNED NOT NULL DEFAULT 0,
          PRIMARY KEY (quest_id, steam_id, item_id, period_key),
          INDEX idx_steam_period (steam_id, period_key)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
      );
    } catch (e: any) {
      this.log.warn(`quest_progress ensure failed: ${e.message}`);
    }

    try {
      await this.query(
        `CREATE TABLE IF NOT EXISTS ${questCompletions} (
          quest_id INT NOT NULL,
          steam_id BIGINT UNSIGNED NOT NULL,
          period_key VARCHAR(16) NOT NULL,
          reward_coins BIGINT NOT NULL,
          completed_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          PRIMARY KEY (quest_id, steam_id, period_key)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
      );
    } catch (e: any) {
      this.log.warn(`quest_completions ensure failed: ${e.message}`);
    }
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
