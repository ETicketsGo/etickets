/**
 * A sparse day series as every day of its window, with the missing days as zero.
 *
 * The reports API returns a day only when something happened on it, which is right for a CSV
 * and wrong for a chart: drawn as it comes, a week with sales on Monday and Friday shows two
 * columns side by side, and the three empty days between them - which ARE the shape - vanish.
 * A day that is absent from the response had nothing in it, so zero is the true value, not an
 * invented one.
 *
 * Days are UTC `YYYY-MM-DD`, as the API keys them. A window longer than `maxDays` is not filled:
 * the series is returned as it came, so a mistyped year cannot build a ten-thousand-column chart.
 */
export function fillDays<T extends { day: string }>(
  series: T[],
  from: string | undefined,
  to: string | undefined,
  empty: (day: string) => T,
  maxDays = 400,
): T[] {
  const sorted = [...series].sort((a, b) => a.day.localeCompare(b.day));
  const start = (from ?? sorted[0]?.day)?.slice(0, 10);
  const end = (to ?? sorted[sorted.length - 1]?.day)?.slice(0, 10);
  if (!start || !end || start > end) return sorted;

  const byDay = new Map(sorted.map((p) => [p.day.slice(0, 10), p]));
  const out: T[] = [];
  const cursor = new Date(`${start}T00:00:00.000Z`);
  const last = new Date(`${end}T00:00:00.000Z`);
  if (Number.isNaN(cursor.getTime()) || Number.isNaN(last.getTime())) return sorted;
  if ((last.getTime() - cursor.getTime()) / 86_400_000 + 1 > maxDays) return sorted;

  while (cursor <= last) {
    const key = cursor.toISOString().slice(0, 10);
    out.push(byDay.get(key) ?? empty(key));
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  // A day the API returned outside the window (a zone edge) is kept rather than dropped.
  for (const p of sorted) if (p.day.slice(0, 10) < start || p.day.slice(0, 10) > end) out.push(p);
  return out.sort((a, b) => a.day.localeCompare(b.day));
}
