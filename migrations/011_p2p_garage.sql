-- Sell VirtualGarage vehicles ("Virtuals") on P2P.
--
-- A Virtual = one row in the plugin-owned, UNPREFIXED `virtual_garage` table (the shop-api
-- and the VirtualGarage Unturned plugin share this MySQL DB). Selling a Virtual on P2P
-- TRANSFERS OWNERSHIP (virtual_garage.steam_id seller -> buyer) — it does NOT mint a redeem
-- code. While a Virtual is listed it must stay locked so the seller can't retrieve it: the
-- new virtual_garage.listed_for_sale flag (1 = listed) is read by the game plugin.
--
-- Safe & additive:
--   * sv_p2p_garage_listings is CREATE IF NOT EXISTS (api-owned).
--   * virtual_garage.listed_for_sale is guarded by information_schema (plain MySQL has no
--     `ADD COLUMN IF NOT EXISTS`) so re-running is a no-op and the plugin-owned table is
--     only ever extended, never altered otherwise.
-- Apply this BEFORE deploying the API/web build that reads garage listings.

CREATE TABLE IF NOT EXISTS `sv_p2p_garage_listings` (
  `id`           BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `seller_steam` CHAR(17)        NOT NULL,
  `garage_id`    INT             NOT NULL,
  `garage_name`  VARCHAR(64)     NOT NULL,
  `legacy_id`    INT UNSIGNED    NOT NULL DEFAULT 0,
  `price`        DOUBLE          NOT NULL,
  `status`       VARCHAR(16)     NOT NULL DEFAULT 'active',
  `buyer_steam`  CHAR(17)        DEFAULT NULL,
  `created_at`   DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `closed_at`    DATETIME        DEFAULT NULL,
  PRIMARY KEY (`id`),
  INDEX `idx_status_created` (`status`, `created_at`),
  INDEX `idx_seller` (`seller_steam`),
  -- helps enforce "one active listing per garage_id" (the lookup is in code under FOR UPDATE;
  -- a partial unique index on (garage_id) WHERE status='active' isn't portable to MySQL).
  INDEX `idx_garage` (`garage_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- virtual_garage.listed_for_sale — 1 while listed (plugin keeps the vehicle locked), 0 otherwise.
-- Guarded so re-running is a no-op. Only ADDs the column; no other virtual_garage column touched.
SET @col_exists := (
  SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE()
    AND TABLE_NAME = 'virtual_garage'
    AND COLUMN_NAME = 'listed_for_sale'
);
SET @ddl := IF(@col_exists = 0,
  'ALTER TABLE `virtual_garage` ADD COLUMN `listed_for_sale` TINYINT(1) NOT NULL DEFAULT 0',
  'SELECT 1');
PREPARE stmt FROM @ddl;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;
