-- Migration 015 — XP -> Coins conversion
--
-- Two NEW shared tables for converting in-game experience (XP) into coins. XP is server-only state
-- (PlayerSkills.experience, in the save files), so the GameMenu plugin owns the actual read/deduct;
-- the web only mirrors + queues. Both tables are additive + idempotent (safe on the shared shop DB).
-- The API also ensures these on boot (DbService.ensureXpTables); this file is the manual parity copy.
--
--   player_xp   — the plugin mirrors each ONLINE player's live XP + online flag here on a timer, so
--                 the web shop can show current XP and an online indicator.
--   xp_requests — web -> game conversion queue. Web inserts 'pending'; the plugin claims it
--                 (pending -> processing), deducts XP in-game, credits coins, then finalizes the row
--                 (done | insufficient | offline | error) with coins_granted / xp_spent.

CREATE TABLE IF NOT EXISTS `sv_player_xp` (
  `steam_id`   VARCHAR(32)      NOT NULL,
  `xp`         BIGINT UNSIGNED  NOT NULL DEFAULT 0,
  `name`       VARCHAR(64)      DEFAULT NULL,
  `online`     TINYINT(1)       NOT NULL DEFAULT 0,
  `updated_at` DATETIME         NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`steam_id`),
  INDEX `idx_online` (`online`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS `sv_xp_requests` (
  `id`            BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `steam_id`      VARCHAR(32)     NOT NULL,
  `requested_xp`  INT UNSIGNED    NOT NULL,
  `status`        ENUM('pending','processing','done','insufficient','offline','error') NOT NULL DEFAULT 'pending',
  `coins_granted` BIGINT          DEFAULT NULL,
  `xp_spent`      INT UNSIGNED    DEFAULT NULL,
  `source`        VARCHAR(16)     NOT NULL DEFAULT 'web',
  `created_at`    DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `processed_at`  DATETIME        DEFAULT NULL,
  PRIMARY KEY (`id`),
  INDEX `idx_status` (`status`),
  INDEX `idx_steam_created` (`steam_id`, `created_at`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
