-- In-app + bot notifications outbox.
-- Written by the API (e.g. when a P2P listing is cancelled/expired/force-closed and a
-- refund redeem code is minted); consumed by two readers:
--   * the web client via GET /notifications/me (+ unread-count, mark-read)
--   * the Discord bot, which polls dm_status='pending' rows and DMs the recipient,
--     then stamps dm_status/dm_sent_at.
-- `payload` is opaque JSON whose shape depends on `kind` (see api notifications.types.ts).

CREATE TABLE IF NOT EXISTS `sv_notifications` (
  `id`          BIGINT UNSIGNED  NOT NULL AUTO_INCREMENT,
  `discord_id`  BIGINT UNSIGNED  NOT NULL,
  `steam_id`    CHAR(17)         DEFAULT NULL,
  `kind`        VARCHAR(32)      NOT NULL,
  `payload`     JSON             DEFAULT NULL,
  `dm_status`   VARCHAR(16)      NOT NULL DEFAULT 'pending',
  `dm_attempts` INT              NOT NULL DEFAULT 0,
  `dm_sent_at`  DATETIME         DEFAULT NULL,
  `read_at`     DATETIME         DEFAULT NULL,
  `created_at`  DATETIME         NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  INDEX `idx_notif_recipient` (`discord_id`, `read_at`),
  INDEX `idx_notif_dm` (`dm_status`, `id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- Surface the minted refund code directly on the listing row so the seller's my-listings
-- view can show it without depending on a (possibly already-read) notification.
-- Populated by P2pService.closeAndRefund on cancel/expire/admin_force_close.
ALTER TABLE `sv_p2p_listings`
  ADD COLUMN IF NOT EXISTS `redeem_code`     VARCHAR(64) DEFAULT NULL AFTER `closed_at`,
  ADD COLUMN IF NOT EXISTS `code_expires_at` DATETIME    DEFAULT NULL AFTER `redeem_code`;
