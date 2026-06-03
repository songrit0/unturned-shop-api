-- Sell vehicles the SAME way the shop sells items.
--
-- Unturned vehicle IDs and item IDs are SEPARATE id spaces, so the redeem-code
-- rows need a `kind` discriminator (0=item, 1=vehicle) the game plugin reads to
-- know which id space rc_code_items.item_id refers to when granting a redeemed code.
--
-- Vehicles use a FIXED price (no base_price/target_stock/elasticity, no pricing cron),
-- unlike sv_market which has supply/demand pricing.
--
-- Safe & additive:
--   * the two new tables are CREATE IF NOT EXISTS
--   * rc_code_items.kind has a DEFAULT 0, so existing INSERTs from the bot/plugin
--     that don't mention it keep writing item rows exactly as before.
-- Apply this BEFORE deploying the API/web build that reads vehicles.

CREATE TABLE IF NOT EXISTS `sv_vehicles` (
  `id`          INT UNSIGNED  NOT NULL,
  `name`        VARCHAR(64)   NOT NULL,
  `description` VARCHAR(512)  NULL,
  `image_url`   VARCHAR(512)  NULL,
  `type_id`     INT           NULL,
  `created_at`  DATETIME      DEFAULT CURRENT_TIMESTAMP,
  `updated_at`  DATETIME      DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  INDEX `idx_vehicles_type` (`type_id`),
  CONSTRAINT `fk_vehicles_type` FOREIGN KEY (`type_id`) REFERENCES `sv_item_types` (`id`) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS `sv_vehicle_market` (
  `vehicle_id` INT UNSIGNED NOT NULL,
  `price`      DOUBLE       NOT NULL DEFAULT 0,
  `amount`     INT          NOT NULL DEFAULT 0,
  `enabled`    TINYINT(1)   NOT NULL DEFAULT 1,
  `created_at` DATETIME     DEFAULT CURRENT_TIMESTAMP,
  `updated_at` DATETIME     DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`vehicle_id`),
  CONSTRAINT `fk_vmarket_vehicle` FOREIGN KEY (`vehicle_id`) REFERENCES `sv_vehicles` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- rc_code_items.kind discriminator — guarded so re-running is a no-op
-- (plain MySQL has no `ADD COLUMN IF NOT EXISTS`, so check information_schema first).
SET @col_exists := (
  SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE()
    AND TABLE_NAME = 'rc_code_items'
    AND COLUMN_NAME = 'kind'
);
SET @ddl := IF(@col_exists = 0,
  'ALTER TABLE `rc_code_items` ADD COLUMN `kind` TINYINT UNSIGNED NOT NULL DEFAULT 0',
  'SELECT 1');
PREPARE stmt FROM @ddl;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;
