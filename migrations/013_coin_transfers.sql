-- Player-to-player Coin transfers.
--
-- The in-game "Coin" wallet (sv_coins) is debited from the SENDER and credited to
-- the RECIPIENT. The sender additionally pays a FLAT fee on top (sender pays
-- amount + fee, recipient receives the full amount, the fee is BURNED — a sink).
-- This table is the immutable audit ledger of every completed transfer; it is the
-- 'transfer' source of the unified Coin transaction-history timeline.
--
-- Safe for the SHARED shop DB (also written by the Discord bot + game plugin):
--   * NEW TABLE — api-owned, nothing existing is touched.
--   * CREATE TABLE IF NOT EXISTS — idempotent, re-running this file is a no-op.
--   * ADDITIVE — no ALTER/DROP/RENAME of any existing table.
--
-- Apply this BEFORE deploying the API/web build that reads/writes this table.

CREATE TABLE IF NOT EXISTS `sv_coin_transfers` (
  `id`              BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `sender_steam`    CHAR(17)        NOT NULL,
  `recipient_steam` CHAR(17)        NOT NULL,
  `amount`          BIGINT          NOT NULL,
  `fee`             BIGINT          NOT NULL DEFAULT 0,
  `created_at`      DATETIME                 DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  INDEX `idx_sender` (`sender_steam`),
  INDEX `idx_recipient` (`recipient_steam`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
