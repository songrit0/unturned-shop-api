-- P2P bundle listings: combine several fill-type items (magazines, fuel cans, tanks,
-- refillables with different fill levels) into one listing/purchase sold as a single unit
-- for one price. Additive only — existing single-item rows are unaffected (is_bundle
-- defaults to 0, all existing code paths untouched).
--
-- For a bundle row: item_id=0 (sentinel, no single item), amount=child item count,
-- quality=0, rot=0, state=''. The real per-item data lives in the *_items child table,
-- mirroring the existing rc_codes/rc_code_items parent+child pattern.

ALTER TABLE `sv_p2p_listings`
  ADD COLUMN IF NOT EXISTS `is_bundle` TINYINT(1) NOT NULL DEFAULT 0 AFTER `state`;

CREATE TABLE IF NOT EXISTS `sv_p2p_listing_items` (
  `id`         BIGINT UNSIGNED  NOT NULL AUTO_INCREMENT,
  `listing_id` BIGINT UNSIGNED  NOT NULL,
  `item_id`    INT UNSIGNED     NOT NULL,
  `amount`     INT UNSIGNED     NOT NULL,
  `quality`    TINYINT UNSIGNED NOT NULL DEFAULT 100,
  `state`      LONGTEXT         NOT NULL DEFAULT '',
  PRIMARY KEY (`id`),
  INDEX `idx_listing` (`listing_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

ALTER TABLE `sv_p2p_purchases`
  ADD COLUMN IF NOT EXISTS `is_bundle` TINYINT(1) NOT NULL DEFAULT 0 AFTER `state`;

CREATE TABLE IF NOT EXISTS `sv_p2p_purchase_items` (
  `id`           BIGINT UNSIGNED  NOT NULL AUTO_INCREMENT,
  `purchase_id`  BIGINT UNSIGNED  NOT NULL,
  `item_id`      INT UNSIGNED     NOT NULL,
  `amount`       INT UNSIGNED     NOT NULL,
  `quality`      TINYINT UNSIGNED NOT NULL DEFAULT 100,
  `state`        LONGTEXT         NOT NULL DEFAULT '',
  PRIMARY KEY (`id`),
  INDEX `idx_purchase` (`purchase_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
