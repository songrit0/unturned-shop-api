-- P2P purchases: per-buyer record of items obtained from a P2P listing.
-- Created on `buyListing` (one row per buy), redeemed by the buyer via /purchases/:id/claim
-- which mints an rc_codes row and stamps redeem_code + claimed_at here.

CREATE TABLE IF NOT EXISTS `sv_p2p_purchases` (
  `id`           BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `buyer_steam`  CHAR(17)        NOT NULL,
  `listing_id`   BIGINT UNSIGNED NOT NULL,
  `item_id`      INT UNSIGNED    NOT NULL,
  `amount`       INT UNSIGNED    NOT NULL,
  `quality`      TINYINT UNSIGNED NOT NULL,
  `state`        LONGTEXT        NOT NULL,
  `rot`          TINYINT UNSIGNED NOT NULL DEFAULT 0,
  `purchased_at` DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `claimed_at`   DATETIME        DEFAULT NULL,
  `redeem_code`  VARCHAR(64)     DEFAULT NULL,
  PRIMARY KEY (`id`),
  INDEX `idx_buyer` (`buyer_steam`),
  INDEX `idx_listing` (`listing_id`),
  INDEX `idx_unclaimed` (`buyer_steam`, `claimed_at`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
