-- Cache Discord identity on sv_links so API joins return human-readable names
-- instead of raw snowflake IDs. Populated on every OAuth login (api) and on
-- /link (bot). Historical rows backfilled by a one-shot bot script.
--
-- All three columns are nullable so the migration is non-destructive — rows
-- written before this migration keep working until the backfill catches up.

ALTER TABLE `sv_links`
  ADD COLUMN IF NOT EXISTS `discord_username`              VARCHAR(64) DEFAULT NULL AFTER `discord_id`,
  ADD COLUMN IF NOT EXISTS `discord_global_name`           VARCHAR(64) DEFAULT NULL AFTER `discord_username`,
  ADD COLUMN IF NOT EXISTS `discord_username_updated_at`   DATETIME    DEFAULT NULL AFTER `discord_global_name`;
