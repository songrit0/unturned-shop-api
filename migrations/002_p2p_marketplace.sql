-- P2P marketplace: player-to-player listings and audit log
-- See plan: MySQLVault Web Management + P2P Marketplace
-- Items listed here are removed from the seller's Vaults.Data and held off-vault
-- in sv_p2p_listings.state (opaque base64, preserved verbatim) until bought/cancelled/expired.

CREATE TABLE IF NOT EXISTS `sv_p2p_listings` (
  `id`           BIGINT UNSIGNED  NOT NULL AUTO_INCREMENT,
  `seller_steam` CHAR(17)         NOT NULL,
  `item_id`      INT UNSIGNED     NOT NULL,
  `amount`       INT UNSIGNED     NOT NULL,
  `quality`      TINYINT UNSIGNED NOT NULL,
  `rot`          TINYINT UNSIGNED NOT NULL DEFAULT 0,
  `state`        LONGTEXT         NOT NULL,
  `price`        DOUBLE           NOT NULL,
  `status`       ENUM('active','sold','cancelled','expired') NOT NULL DEFAULT 'active',
  `buyer_steam`  CHAR(17)         DEFAULT NULL,
  `created_at`   DATETIME         NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `closed_at`    DATETIME         DEFAULT NULL,
  PRIMARY KEY (`id`),
  INDEX `idx_seller` (`seller_steam`),
  INDEX `idx_status_item` (`status`, `item_id`),
  INDEX `idx_buyer` (`buyer_steam`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS `sv_p2p_log` (
  `id`         BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `listing_id` BIGINT UNSIGNED NOT NULL,
  `action`     ENUM('list','buy','cancel','expire','admin_force_close') NOT NULL,
  `actor`      VARCHAR(64)     NOT NULL,
  `meta`       JSON            DEFAULT NULL,
  `at`         DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  INDEX `idx_listing` (`listing_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
