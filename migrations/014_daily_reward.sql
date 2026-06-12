-- Migration 014: Daily reward (website-claimed, flat, two tiers normal/vip).
-- DOCUMENTATION ONLY — the schema is actually applied idempotently by
-- DailyService.onModuleInit() (CREATE TABLE IF NOT EXISTS), matching the
-- ensure* pattern used everywhere else in this codebase. Nothing reads this file.
--
-- Tier is an ENUM('normal','vip'); VIP is resolved at claim/status time from an
-- active sv_vip_grants row. Each tier grants coins (sv_coins) + a bundle of
-- items/vehicles delivered through a single 1-use rc_code (rc_code_items.kind:
-- 0=item, 1=vehicle). The whole claim is one atomic shop-DB transaction gated by
-- UNIQUE(steam_id, claim_date); claim_date is a precomputed 06:00-Asia/Bangkok
-- 'YYYY-MM-DD' day key (app-owned, same boundary as the gacha day).

-- (a) per-tier scalar config: coins + flags. One row per tier (seeded).
CREATE TABLE IF NOT EXISTS `sv_daily_reward_config` (
  tier ENUM('normal','vip') NOT NULL,
  enabled TINYINT(1) NOT NULL DEFAULT 1,
  coins BIGINT NOT NULL DEFAULT 0,
  code_ttl_days INT NOT NULL DEFAULT 30,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (tier)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

INSERT IGNORE INTO `sv_daily_reward_config` (tier, enabled, coins, code_ttl_days)
VALUES ('normal', 1, 0, 30), ('vip', 1, 0, 30);

-- (b) per-tier item/vehicle list (kind 0=item, 1=vehicle).
CREATE TABLE IF NOT EXISTS `sv_daily_reward_items` (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  tier ENUM('normal','vip') NOT NULL,
  item_id INT UNSIGNED NOT NULL,
  amount INT UNSIGNED NOT NULL DEFAULT 1,
  quality TINYINT UNSIGNED NOT NULL DEFAULT 100,
  kind TINYINT UNSIGNED NOT NULL DEFAULT 0,
  label VARCHAR(128) NULL,
  image_url VARCHAR(512) NULL,
  sort INT NOT NULL DEFAULT 0,
  enabled TINYINT(1) NOT NULL DEFAULT 1,
  PRIMARY KEY (id),
  INDEX idx_tier (tier, enabled, sort)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- (c) claim ledger — UNIQUE(steam_id, claim_date) is the race-safe once-per-day gate.
CREATE TABLE IF NOT EXISTS `sv_daily_claims` (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  steam_id CHAR(17) NOT NULL,
  claim_date VARCHAR(10) NOT NULL,
  tier ENUM('normal','vip') NOT NULL,
  coins BIGINT NOT NULL DEFAULT 0,
  redeem_code VARCHAR(64) NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_steam_day (steam_id, claim_date),
  INDEX idx_day (claim_date)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
