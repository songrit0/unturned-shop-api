-- Seed / refresh the in-game HELP topics (sv_help_topics) shown in the GameMenu phone HELP app.
-- Admins can edit/add/delete these afterwards from the web shop (Admin > Help / Guide).
--
-- The first line CLEARS all existing topics so this becomes the authoritative set.
-- Remove it if you want to KEEP topics you already added.
DELETE FROM `sv_help_topics`;

INSERT INTO `sv_help_topics` (title, body, category, icon, sort_order, enabled) VALUES
('Welcome to the server',
'Open this phone from your inventory (Plugin Key 1, or type /menu).

Home shows your wallet, the MARKET, KITS, KEYS and SELL apps, plus this HELP guide.

Tap any topic to read it. Tap the < arrow to go back.',
'Basics', '!', 10, 1),

('Web shop',
'Manage everything from the website shop:
- Log in with Discord and link your Steam account.
- Buy and sell items, browse the player market (P2P).
- See your coin balance and full transaction history.
- Convert XP to coins, claim daily rewards, and top up.

The website and the game share the same coins and the same market, so changes sync both ways.',
'Web', 'W', 20, 1),

('Convert XP to Coins',
'On the Home wallet, tap CONVERT, type how many coins you want, then CONFIRM.

The phone shows the XP it will cost. Rate: 1 XP = 1 coin, minus a 10 percent fee.
Example: 900 coins costs 1000 XP.

You can also convert on the web shop while you are online on the server.',
'Wallet', '$', 30, 1),

('Sell your items (P2P)',
'Open the SELL app (or the SELL tile on Home).

The phone opens a storage box - drag the item you want to sell into it.
Then enter a price on the keypad and CONFIRM.

This lists the item on the player market. When someone buys it, the item is delivered to them and you receive the coins minus a small commission.',
'Market', 'S', 40, 1),

('Buy from the Market (P2P)',
'Open the MARKET app to see items other players have listed.

Tap BUY on a card to buy it with your coins. The item is delivered straight to your inventory.

The same listings are also on the web shop, so you can buy there too.',
'Market', 'M', 50, 1),

('Knockdown system',
'Instead of dying instantly, lethal damage puts you in a DOWNED state: you fall, can only crawl slowly, and bleed out over time.

A teammate can REVIVE you by using a medical item (dressing or medkit) on you while you are down.
If no one revives you before the timer runs out, you die.

Logging out while downed still counts as a death.

Not a fan of being downed? Type /knockdown off (or /kd off) to die normally instead.
/knockdown on turns it back on. /knockdown status shows your current setting. Your choice is saved across sessions.',
'Combat', 'K', 60, 1),

('Dead Box (death loot)',
'When you die, the loot you drop is gathered into a public DEAD BOX at your death spot.

Anyone can open it and take items. It cannot be salvaged and it disappears once it is empty.

Get back to your box quickly to recover your gear before others grab it.',
'Combat', 'D', 70, 1),

('Sort your inventory',
'/sort sorts your inventory automatically.
/sortui opens the sorter panel: sort, quickstack, deposit, withdraw and restock.

The panel can also pop up automatically when you open your inventory or a container.',
'Inventory', 'I', 80, 1),

('Hotkeys (Plugin Keys)',
'You can bind quick commands to Plugin Keys 2 to 5.

Step 1: in Options > Controls, scroll to Plugin Key 2..5 and bind each to a real key (for example F2).
Step 2: open the KEYS app and tap CHANGE to pick a command, OR type /sethotkey <2-5> <command>.

Plugin Key 1 is what opens this phone.',
'Controls', 'H', 90, 1),

('Tool Cupboard (base decay)',
'Place a Tool Cupboard inside your base to protect nearby barricades and structures from decay.

/decay tells you whether your current spot is protected.
/checkhp (or /hp) shows the HP of the barricade or structure you are looking at.

Keep the cupboard alive, or your base will start to decay.',
'Base', 'T', 100, 1),

('Home Teleport (beds)',
'Place a BED and claim it to set a home. You can claim several homes.

/home teleports you to your home (or /home <name> for a specific one).
/homes lists your homes.
/renamehome <name> <new name> renames one.
/destroyhome <name> removes one.

There is a short warmup before the teleport, and moving cancels it.',
'Teleport', 'B', 110, 1),

('Teleport to players (TPA)',
'Request to teleport to another player:
/tpa <player> sends a request.
/tpa a accepts a request sent to you.
/tpa c cancels your own request. /tpa d denies a request.

/tpa whitelist <player> always allows that player to TP to you.
/tpa blacklist <player> blocks a player.
/tpa autoaccept toggles auto-accepting requests from your group.',
'Teleport', 'P', 120, 1),

('Vaults (extra storage)',
'/vault opens your vault (or the last one you used).
/vault <name> opens a named vault, for example /vault vip.
/vaults lists the vaults you can open.
/trash opens a throwaway box that empties when you close it.
/fixvault removes broken items after mod changes.

Vaults are saved and persist across server restarts.',
'Storage', 'V', 130, 1),

('Vehicle Garage',
'Store your vehicles safely instead of leaving them out:
/gadd <name> (or /ga) stores the vehicle you are looking at.
/garage lists the vehicles in your garage.
/gretrieve <name> takes a vehicle back out.
/garagedelete <name> deletes one without spawning it.',
'Vehicles', 'G', 140, 1);
