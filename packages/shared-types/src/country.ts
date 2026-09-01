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

/**
 * The currency a seller in this country prices and is paid in.
 *
 * ── WHAT THIS IS FOR, AND WHAT IT MUST NEVER BE USED FOR ───────────────────────────
 * This answers "an organizer is putting on a show in Boise — what currency are they
 * selling in?". It is about the SELLER'S location, which is a fact about the event, and
 * it decides real money: the ticket price, the fees, the tax and which payment provider
 * the charge goes to.
 *
 * It must never be applied to the BUYER'S location. Converting a price for a visitor
 * would need an exchange-rate source this platform does not have and a multi-currency
 * merchant account it does not hold, and the result would be a number nobody will
 * actually be charged. A visitor in Toronto looking at a Mumbai concert sees rupees,
 * because rupees are what their card will be billed. `visitorCountry()` in web-kit exists
 * for ordering and defaults and carries the same warning.
 *
 * ── WHY IT RETURNS NULL RATHER THAN GUESSING ───────────────────────────────────────
 * An unknown country gets `null`, and callers fall back to their own explicit default.
 * The alternative — assuming a currency for a market nobody has configured — is how an
 * organizer ends up selling in a currency they never chose, which is precisely the defect
 * this replaced: every ticket type defaulted to INR regardless of where it was.
 */
const COUNTRY_CURRENCY: Record<string, string> = {
  IN: 'INR',
  US: 'USD',
  CA: 'CAD',
  GB: 'GBP',
  AE: 'AED',
  SG: 'SGD',
  AU: 'AUD',
  NZ: 'NZD',
};

export function currencyForCountry(country: string | null | undefined): string | null {
  if (!country) return null;
  const needle = country.trim().toLowerCase();
  if (!needle) return null;

  // Aliased first, so "United States", "USA" and "US" all reach the same answer — the
  // database stores whatever the organizer typed into the venue form.
  for (const [alpha2, currency] of Object.entries(COUNTRY_CURRENCY)) {
    if (countryAliases(alpha2).includes(needle)) return currency;
  }
  return null;
}
