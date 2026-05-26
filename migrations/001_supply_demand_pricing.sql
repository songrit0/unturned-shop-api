-- Supply/Demand pricing for sv_market
-- Adds: base_price (anchor), target_stock (anchor), elasticity (responsiveness)
-- Existing rows get base_price=price, target_stock=GREATEST(amount,1), elasticity=0.5

ALTER TABLE `sv_market`
  ADD COLUMN IF NOT EXISTS `base_price`   DOUBLE NOT NULL DEFAULT 0      AFTER `price`,
  ADD COLUMN IF NOT EXISTS `target_stock` INT    NOT NULL DEFAULT 1      AFTER `base_price`,
  ADD COLUMN IF NOT EXISTS `elasticity`   DOUBLE NOT NULL DEFAULT 0.5    AFTER `target_stock`;

-- Backfill: snapshot current state as the anchor
UPDATE `sv_market`
SET
  base_price = IF(base_price = 0, price, base_price),
  target_stock = IF(target_stock <= 1, GREATEST(amount, 1), target_stock),
  elasticity = IF(elasticity = 0, 0.5, elasticity);
