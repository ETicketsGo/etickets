/**
 * Matching a country when the two sides spell it differently.
 *
 * ── THE PROBLEM THIS SOLVES ────────────────────────────────────────────────────────
 * A country arrives at this platform in three shapes and none of them agree:
 *
 *   - `IN` — from an edge header (`cf-ipcountry`) or a device region. ISO alpha-2.
 *   - `India` — what an organizer typed into the venue form, and what is in the database.
 *   - `india` / `INDIA` — the same thing, entered by somebody else on a different day.
 *
 * Anything comparing these with `===` silently finds nothing, and "silently finds nothing"
 * is the worst failure a discovery filter can have: the customer sees an empty page and
 * concludes the platform has nothing on sale, rather than that the filter misfired.
 *
 * ── WHY THIS IS A SHORT LIST AND NOT A LIBRARY ─────────────────────────────────────
 * A full ISO-3166 table is 250 rows to serve a handful of launch markets, and it would
 * still not cover "USA" vs "United States" vs "United States of America" — which is a
 * data-entry problem, not a standards problem. So this names the markets the platform
 * actually sells in, and falls back to comparing the value with itself for everything
 * else, which is correct for any venue already storing a code.
 *
 * The fallback matters: an unknown country is not an error, it just means the alias list
 * adds nothing. Discovery still works, and a new market keeps working before anybody
 * remembers to add it here.
 */

/** Alpha-2 → every spelling of that country we expect to meet in stored data. */
const ALIASES: Record<string, string[]> = {
  IN: ['india', 'in'],
  US: ['united states', 'united states of america', 'usa', 'us'],
  CA: ['canada', 'ca'],
  GB: ['united kingdom', 'great britain', 'uk', 'gb'],
  AE: ['united arab emirates', 'uae', 'ae'],
  SG: ['singapore', 'sg'],
  AU: ['australia', 'au'],
  NZ: ['new zealand', 'nz'],
};

/**
 * Every spelling that means the same country as `value`, lowercased.
 *
 * Accepts either shape — `IN` or `India` — because callers get it from wherever they got
 * it, and having to know which one they hold is exactly the bug this file exists to stop.
 * Always includes the input itself, so an unknown country matches on its own spelling.
 */
export function countryAliases(value: string): string[] {
  const needle = value.trim().toLowerCase();
  if (!needle) return [];

  const direct = ALIASES[needle.toUpperCase()];
  if (direct) return unique([needle, ...direct]);

  for (const [alpha2, names] of Object.entries(ALIASES)) {
    if (names.includes(needle)) return unique([needle, alpha2.toLowerCase(), ...names]);
  }
  return [needle];
}

/** Whether a stored country name is the country the caller named, in any spelling. */
export function countryMatches(stored: string, value: string): boolean {
  return countryAliases(value).includes(stored.trim().toLowerCase());
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}
