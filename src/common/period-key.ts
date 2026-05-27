export type QuestResetType = 'once' | 'daily' | 'weekly';

/**
 * Returns the period key for a given reset_type using server local time.
 * Other components (SellVault plugin, Discord bot) MUST mirror this logic.
 *   'once'   -> 'lifetime'
 *   'daily'  -> YYYY-MM-DD
 *   'weekly' -> YYYY-Www (ISO week)
 */
export function periodKey(resetType: QuestResetType, now: Date = new Date()): string {
  if (resetType === 'once') return 'lifetime';
  if (resetType === 'daily') {
    const y = now.getFullYear();
    const m = String(now.getMonth() + 1).padStart(2, '0');
    const d = String(now.getDate()).padStart(2, '0');
    return `${y}-${m}-${d}`;
  }
  // weekly: ISO-8601 week number based on server local date
  const d = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  // Thursday in current week determines the year
  const dayNum = (d.getDay() + 6) % 7; // Mon=0..Sun=6
  d.setDate(d.getDate() - dayNum + 3);
  const firstThursday = new Date(d.getFullYear(), 0, 4);
  const firstDayNum = (firstThursday.getDay() + 6) % 7;
  firstThursday.setDate(firstThursday.getDate() - firstDayNum + 3);
  const week = 1 + Math.round((d.getTime() - firstThursday.getTime()) / (7 * 24 * 60 * 60 * 1000));
  return `${d.getFullYear()}-W${String(week).padStart(2, '0')}`;
}
