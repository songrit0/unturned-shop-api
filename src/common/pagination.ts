export interface Paginated<T> {
  items: T[];
  total: number;
  page: number;
  limit: number;
  pages: number;
}

export function normalizePage(
  page?: number,
  limit?: number,
): { page: number; limit: number; offset: number } {
  const p = Math.max(1, Number.isFinite(page as number) ? Math.floor(page as number) : 1);
  const rawL = Number.isFinite(limit as number) ? Math.floor(limit as number) : 20;
  const l = Math.min(100, Math.max(1, rawL));
  return { page: p, limit: l, offset: (p - 1) * l };
}
