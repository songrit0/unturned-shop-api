-- Steam-ID + PIN web login.
-- A player sets a 6-digit PIN in-game via /shoppin; the plugin POSTs it to the API (POST /bot/steam-pin)
-- which hashes it (node:crypto scrypt + per-row salt) and stores it here. The web login
-- (POST /auth/steam-pin) verifies against this row and issues a JWT.
-- Hashing/verification live ONLY in the API; the plaintext PIN is never stored.
-- failed_attempts / locked_until implement the brute-force lockout (5 fails -> 15 min lock).
CREATE TABLE IF NOT EXISTS `sv_web_pins` (
  `steam_id`        CHAR(17)        NOT NULL,
  `pin_hash`        VARBINARY(255)  NOT NULL,
  `pin_salt`        VARBINARY(32)   NOT NULL,
  `failed_attempts` INT             NOT NULL DEFAULT 0,
  `locked_until`    DATETIME        DEFAULT NULL,
  `updated_at`      DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  `created_at`      DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`steam_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
