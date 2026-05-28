-- Community item info submissions. Players propose updates to sv_items metadata
-- (name / description / image_url / type_id); admins approve or reject.
-- One pending+approved+rejected row per (item_id, submitter) -- UNIQUE prevents
-- spam re-submits; on re-submit clients can DELETE+POST or PATCH a pending row.

CREATE TABLE IF NOT EXISTS `sv_item_submissions` (
  `id`              BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `item_id`         INT UNSIGNED    NOT NULL,
  `submitter_steam` CHAR(17)        NOT NULL,
  `name`            VARCHAR(128)    DEFAULT NULL,
  `description`     TEXT            DEFAULT NULL,
  `image_url`       TEXT            DEFAULT NULL,
  `type_id`         INT             DEFAULT NULL,
  `status`          ENUM('pending','approved','rejected') NOT NULL DEFAULT 'pending',
  `admin_note`      TEXT            DEFAULT NULL,
  `reviewed_by`     CHAR(17)        DEFAULT NULL,
  `reviewed_at`     DATETIME        DEFAULT NULL,
  `submitted_at`    DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_user_item` (`item_id`, `submitter_steam`),
  INDEX `idx_status` (`status`),
  INDEX `idx_item` (`item_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
