-- Split the market trade flags into two independent axes:
--   enabled           = the shop BUYS this item from players
--                       (drives the "Sell to shop" board + in-game SellVault, which
--                        already filters `WHERE enabled=1` — meaning unchanged)
--   enabled_isforsell = the shop SELLS this item to players (drives the Shop page)
--
-- States: (enabled, enabled_isforsell)
--   (1,1) buy + sell   (1,0) buy-only   (0,1) sell-only   (0,0) hidden
--
-- Apply this BEFORE deploying the API/web build that reads enabled_isforsell.
-- Safe & additive: new column has a DEFAULT, so existing INSERTs from the
-- SellVault plugin / Discord bot that don't mention it keep working.

ALTER TABLE `sv_market`
  ADD COLUMN `enabled_isforsell` TINYINT(1) NOT NULL DEFAULT 1 AFTER `enabled`;

-- Preserve current behaviour: everything currently enabled stays for-sale.
UPDATE `sv_market` SET `enabled_isforsell` = `enabled`;
