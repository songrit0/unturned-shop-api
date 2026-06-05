-- Per-item Meowcoin pricing.
--
-- Meowcoin is a SEPARATE currency from the in-game "Coin": Coin lives in this
-- (external, shared) shop DB, Meowcoin lives in a separate Pi5-local MariaDB.
-- This migration only adds the PRICE TAG a player pays in Meowcoin; the wallet
-- balance/log are never stored here.
--
-- Three new NULLABLE BIGINT columns:
--   sv_market.meowcoin_price          — Meowcoin price of a shop item
--   sv_vehicle_market.meowcoin_price  — Meowcoin price of a vehicle
--   sv_vip_packages.price_meowcoins   — Meowcoin price of a VIP package
--
-- Semantics: NULL = NOT buyable with Meowcoin (Coin-only). A non-null integer is
-- the whole-Meowcoin price.
--
-- Safe for the SHARED shop DB (also written by the Discord bot + game plugin):
--   * ADDITIVE — only ADD COLUMN, nothing dropped/renamed/retyped.
--   * NULLABLE with no default needed — existing INSERTs from the bot/plugin that
--     don't mention these columns keep working unchanged (the column is just NULL).
--   * IDEMPOTENT — each ADD COLUMN is guarded by an information_schema COUNT check
--     and run via PREPARE/EXECUTE (plain MySQL has no `ADD COLUMN IF NOT EXISTS`),
--     so re-running this file is a no-op.
--
-- Apply this BEFORE deploying the API/web build that reads/writes these columns.

-- sv_market.meowcoin_price
SET @col_exists := (
  SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE()
    AND TABLE_NAME = 'sv_market'
    AND COLUMN_NAME = 'meowcoin_price'
);
SET @ddl := IF(@col_exists = 0,
  'ALTER TABLE `sv_market` ADD COLUMN `meowcoin_price` BIGINT NULL DEFAULT NULL',
  'SELECT 1');
PREPARE stmt FROM @ddl;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

-- sv_vehicle_market.meowcoin_price
SET @col_exists := (
  SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE()
    AND TABLE_NAME = 'sv_vehicle_market'
    AND COLUMN_NAME = 'meowcoin_price'
);
SET @ddl := IF(@col_exists = 0,
  'ALTER TABLE `sv_vehicle_market` ADD COLUMN `meowcoin_price` BIGINT NULL DEFAULT NULL',
  'SELECT 1');
PREPARE stmt FROM @ddl;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

-- sv_vip_packages.price_meowcoins
SET @col_exists := (
  SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE()
    AND TABLE_NAME = 'sv_vip_packages'
    AND COLUMN_NAME = 'price_meowcoins'
);
SET @ddl := IF(@col_exists = 0,
  'ALTER TABLE `sv_vip_packages` ADD COLUMN `price_meowcoins` BIGINT NULL DEFAULT NULL',
  'SELECT 1');
PREPARE stmt FROM @ddl;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;
