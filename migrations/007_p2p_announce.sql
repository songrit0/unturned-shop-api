-- P2P listing announce watermark.
-- The Discord bot announces new active listings to a channel; `announced_at` lets the bot
-- (or a future API sweep) mark which listings it has already posted, so restarts don't
-- re-announce. NULL = not yet announced. Set by the announce loop, not by createListing.
ALTER TABLE `sv_p2p_listings`
  ADD COLUMN IF NOT EXISTS `announced_at` DATETIME NULL AFTER `code_expires_at`;
