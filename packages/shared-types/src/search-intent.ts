/**
 * Deterministic natural-language search parsing (v2.0 WS6). Extracts category, city,
 * date-range and simple filters from a free-text query with typo tolerance and
 * synonyms — no AI required. An AI provider may later refine the residual text, but
 * this deterministic pass always runs first and is the sole path when AI is disabled.
 */

export interface SearchIntent {
  raw: string;
  /** Residual free-text after filters are extracted. */
  text: string;
  category?: string;
  city?: string;
  dateFrom?: string; // ISO date (yyyy-mm-dd)
  dateTo?: string;
  freeOnly?: boolean;
  /** Human-readable notes on what was interpreted (for "showing results for…"). */
  applied: string[];
}

export interface SearchParseOptions {
  categories: string[];
  cities: string[];
  now: Date;
}

// Category synonyms → canonical category token (matched case-insensitively).
const CATEGORY_SYNONYMS: Record<string, string> = {
  music: 'Concert',
  concert: 'Concert',
  gig: 'Concert',
  comedy: 'Comedy',
  standup: 'Comedy',
  sport: 'Sports',
  sports: 'Sports',
  match: 'Sports',
  theatre: 'Theatre',
  theater: 'Theatre',
  play: 'Theatre',
  workshop: 'Workshop',
  conference: 'Conference',
  festival: 'Festival',
  movie: 'Movie',
  film: 'Movie',
};

/** Bounded Levenshtein (early-exit at maxDistance+1) for typo tolerance. */
export function editDistance(a: string, b: string, max = 2): number {
  a = a.toLowerCase();
  b = b.toLowerCase();
  if (Math.abs(a.length - b.length) > max) return max + 1;
  const prev = new Array(b.length + 1).fill(0).map((_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let best = i;
    let diag = prev[0];
    prev[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      const val = Math.min(prev[j] + 1, prev[j - 1] + 1, diag + cost);
      diag = prev[j];
      prev[j] = val;
      best = Math.min(best, val);
    }
    if (best > max) return max + 1;
  }
  return prev[b.length];
}

/** Fuzzy-match a token against a candidate list; returns the best within tolerance. */
function fuzzyMatch(token: string, candidates: string[], max = 2): string | undefined {
  let bestCand: string | undefined;
  let bestDist = max + 1;
  for (const c of candidates) {
    const d = editDistance(token, c, max);
    if (d < bestDist) {
      bestDist = d;
      bestCand = c;
    }
  }
  return bestDist <= max ? bestCand : undefined;
}

function iso(d: Date): string {
  return d.toISOString().slice(0, 10);
}

export function parseSearchQuery(raw: string, opts: SearchParseOptions): SearchIntent {
  const intent: SearchIntent = { raw, text: raw.trim(), applied: [] };
  let words = intent.text.split(/\s+/).filter(Boolean);

  // "in <city>" / "near <city>" location intent.
  for (let i = 0; i < words.length; i++) {
    const w = words[i].toLowerCase();
    if ((w === 'in' || w === 'near') && i + 1 < words.length) {
      const cityGuess = words[i + 1];
      const match = fuzzyMatch(cityGuess, opts.cities, 2);
      if (match) {
        intent.city = match;
        intent.applied.push(`city: ${match}`);
        words.splice(i, 2);
        i -= 1;
        continue;
      }
    }
  }

  // Date intent phrases.
  const lower = words.join(' ').toLowerCase();
  const now = opts.now;
  const today = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const dayMs = 86_400_000;
  const setRange = (from: Date, to: Date, label: string, phrase: RegExp) => {
    intent.dateFrom = iso(from);
    intent.dateTo = iso(to);
    intent.applied.push(label);
    words = words.filter((w) => !phrase.test(w.toLowerCase()));
  };
  if (/\btoday\b/.test(lower)) {
    setRange(today, today, 'date: today', /^today$/);
  } else if (/\btomorrow\b/.test(lower)) {
    const t = new Date(today.getTime() + dayMs);
    setRange(t, t, 'date: tomorrow', /^tomorrow$/);
  } else if (/\bthis weekend\b/.test(lower)) {
    const dow = today.getUTCDay();
    const sat = new Date(today.getTime() + ((6 - dow + 7) % 7) * dayMs);
    const sun = new Date(sat.getTime() + dayMs);
    intent.dateFrom = iso(sat);
    intent.dateTo = iso(sun);
    intent.applied.push('date: this weekend');
    words = words.filter((w) => !['this', 'weekend'].includes(w.toLowerCase()));
  } else if (/\bthis week\b/.test(lower)) {
    setRangeWeek(today, dayMs, intent);
    words = words.filter((w) => !['this', 'week'].includes(w.toLowerCase()));
  }

  // Filters.
  if (/\bfree\b/.test(words.join(' ').toLowerCase())) {
    intent.freeOnly = true;
    intent.applied.push('free only');
    words = words.filter((w) => w.toLowerCase() !== 'free');
  }

  // Category (synonym then fuzzy against real categories).
  for (let i = 0; i < words.length; i++) {
    const token = words[i].toLowerCase().replace(/[^a-z]/g, '');
    const synonym = CATEGORY_SYNONYMS[token];
    const match = synonym ?? fuzzyMatch(words[i], opts.categories, 1);
    if (match) {
      intent.category = match;
      intent.applied.push(`category: ${match}`);
      words.splice(i, 1);
      break;
    }
  }

  intent.text = words.join(' ').trim();
  return intent;
}

function setRangeWeek(today: Date, dayMs: number, intent: SearchIntent) {
  intent.dateFrom = today.toISOString().slice(0, 10);
  intent.dateTo = new Date(today.getTime() + 6 * dayMs).toISOString().slice(0, 10);
  intent.applied.push('date: this week');
}

/** Popular fallback suggestions when a search returns nothing. */
export function emptyResultSuggestions(intent: SearchIntent, popular: string[]): string[] {
  const tips: string[] = [];
  if (intent.city) tips.push(`Remove the "${intent.city}" location filter`);
  if (intent.category) tips.push(`Try a different category`);
  if (intent.dateFrom) tips.push('Widen the date range');
  if (intent.freeOnly) tips.push('Include paid events');
  return tips.length ? tips : popular.slice(0, 5).map((p) => `Try "${p}"`);
}
