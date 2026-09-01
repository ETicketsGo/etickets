'use client';

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { MapPin, Check, Crosshair, Globe, Search, X, Loader2 } from 'lucide-react';
import { api, type ResolvedLocation, type SellableCity } from './api';
import { visitorCountry } from './locale';

/**
 * The city the customer is shopping in.
 *
 * ── THE DECISION THIS ENCODES ──────────────────────────────────────────────────────
 * There are three ways to know where somebody is and all three are wrong sometimes, so
 * the product question is not "which one" but "what do we do with a guess". The answer
 * here, matching how every ticketing site people already use behaves:
 *
 *   1. A choice the person made themselves wins, forever, and is never re-guessed.
 *   2. Absent a choice, apply the server's guess ONLY if it is confident — which today
 *      means real coordinates, which are only ever sent after they pressed a button.
 *   3. Otherwise show the guess as a suggestion they can accept or change, and in the
 *      meantime scope to their COUNTRY — see below — rather than to the whole world.
 *
 * The city is kept on the device rather than the account. Someone who travels wants the
 * city they are in, not the one they picked at home last month, and a per-device choice
 * gets that right without anyone having to think about it.
 *
 * ── WHY A COUNTRY AND NOT JUST A CITY ──────────────────────────────────────────────
 * A city guess is often wrong and a city filter is narrow, so a wrong one empties the
 * page. A country guess is right far more often and is broad enough that being wrong
 * about the city inside it costs nothing. That asymmetry is the whole reason the country
 * is applied silently while the city is only ever suggested: someone in Hyderabad should
 * not have to scroll past a comedy night in Idaho to find out what is on near them, and
 * should not be shown an empty page if we guess Bengaluru.
 */
const STORAGE_KEY = 'etg.city';

/** Stored when the person deliberately chose everywhere, so we stop suggesting at them. */
const ALL_CITIES = '__all__';

/** Reading storage throws in some privacy modes; a missing city is never worth a crash. */
function readStoredCity(): string | null {
  try {
    return globalThis.localStorage?.getItem(STORAGE_KEY) ?? null;
  } catch {
    return null;
  }
}

function writeStoredCity(city: string | null): void {
  try {
    if (city) globalThis.localStorage?.setItem(STORAGE_KEY, city);
    else globalThis.localStorage?.removeItem(STORAGE_KEY);
  } catch {
    /* a preference we cannot persist is still worth honouring for this session */
  }
}

export interface CityPreference {
  /** The city to filter by, or null for everywhere. */
  city: string | null;
  /**
   * The country to scope to when no city is chosen, or null when we do not know.
   *
   * Null once the customer picks "All cities" by hand: that is them saying they want the
   * whole platform, and re-applying a country hint over the top would ignore them.
   */
  country: string | null;
  /** A few cities worth offering immediately. Never the complete list — see `searchCities`. */
  topCities: SellableCity[];
  /** A guess we have not applied, worth offering. Null once accepted or dismissed. */
  suggestion: ResolvedLocation | null;
  /** Whether the person has made an explicit choice (so nothing should be suggested). */
  chosen: boolean;
  /**
   * Choose a city, or choose everywhere.
   *
   * `null` here means EVERYWHERE, deliberately — it is what "Browse all cities" does, and
   * it drops the country hint too. To stop filtering by city while staying in your own
   * country, call `clearCity()`: those are different intents and conflating them made a
   * plain title search silently widen the page to the whole world.
   */
  setCity: (city: string | null) => void;
  /** Stop filtering by city, keeping the country scope and forgetting the stored choice. */
  clearCity: () => void;
  dismissSuggestion: () => void;
  /** Ask the browser for coordinates. Only ever call from a click. */
  useMyLocation: () => Promise<void>;
  locating: boolean;
  /** Prefix search over sellable cities, run on the server. */
  searchCities: (q: string) => Promise<SellableCity[]>;
}

export function useCityPreference(): CityPreference {
  // Read lazily rather than in an effect: the value is known synchronously on the client,
  // and initialising to null first would flash "All cities" over the chosen one.
  const [city, setCityState] = useState<string | null>(() =>
    typeof window === 'undefined' ? null : readStoredCity(),
  );
  const [chosen, setChosen] = useState<boolean>(() =>
    typeof window === 'undefined' ? false : readStoredCity() !== null,
  );
  const [country, setCountry] = useState<string | null>(null);
  const [topCities, setTopCities] = useState<SellableCity[]>([]);
  const [suggestion, setSuggestion] = useState<ResolvedLocation | null>(null);
  const [locating, setLocating] = useState(false);

  useEffect(() => {
    let cancelled = false;
    /*
      The browser's own region, sent as a hint.

      Without it this call has only the edge header to go on, and the edge header exists
      only where a CDN puts one there — so in any environment without one the answer was
      always "we do not know", and the country scoping below would never do anything at
      all. The locale is a weaker signal (a US-English browser in Toronto reports US) and
      that is acceptable for choosing what to show first; it is never allowed to gate
      access or change a price.
    */
    api.location
      .resolve({ region: visitorCountry() ?? undefined })
      .then((result) => {
        if (cancelled) return;
        setTopCities(result.topCities);
        // A stored '__all__' means they asked for everywhere; a country would undo that.
        if (readStoredCity() === ALL_CITIES) return;
        setCountry(result.country);
        if (readStoredCity() !== null) return; // their choice stands
        if (result.confident && result.city) {
          setCityState(result.city);
          // Deliberately NOT persisted and NOT marked chosen: applying a guess is not the
          // same as the person picking, and next visit deserves a fresh look.
          return;
        }
        if (result.city) setSuggestion(result);
      })
      .catch(() => {
        // Location is an enhancement. If it fails the customer browses everything, which
        // is exactly what happened before this existed.
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const setCity = useCallback((next: string | null) => {
    setCityState(next);
    setChosen(true);
    setSuggestion(null);
    // Choosing "All cities" clears the country hint too. Somebody who asked for everywhere
    // and still got only their own country would reasonably call the control broken.
    if (next === null) setCountry(null);
    // "All cities" is a real choice and is remembered as one — storing null would make the
    // next visit guess again at somebody who already said they wanted everything.
    writeStoredCity(next ?? ALL_CITIES);
  }, []);

  const clearCity = useCallback(() => {
    setCityState(null);
    setChosen(false);
    setSuggestion(null);
    // Storage cleared rather than set to '__all__': this is "I have not chosen a city",
    // not "I want everywhere", so the next visit is free to guess again.
    writeStoredCity(null);
  }, []);

  const useMyLocation = useCallback(async () => {
    if (!globalThis.navigator?.geolocation) return;
    setLocating(true);
    try {
      const position = await new Promise<GeolocationPosition>((resolve, reject) => {
        globalThis.navigator.geolocation.getCurrentPosition(resolve, reject, {
          timeout: 8000,
          maximumAge: 300_000,
        });
      });
      const result = await api.location.resolve({
        latitude: position.coords.latitude,
        longitude: position.coords.longitude,
      });
      setTopCities(result.topCities);
      setCountry(result.country);
      // Coordinates come from a button press, so this IS their choice — persisted as one.
      if (result.city) setCity(result.city);
    } catch {
      // Declined, timed out, or nowhere near a city we serve. The picker is still open.
    } finally {
      setLocating(false);
    }
  }, [setCity]);

  const searchCities = useCallback(
    (q: string) => api.location.cities({ q, limit: 8 }).catch(() => []),
    [],
  );

  return {
    // A stored '__all__' means everywhere, explicitly.
    city: city === ALL_CITIES ? null : city,
    country,
    topCities,
    suggestion,
    chosen,
    setCity,
    clearCity,
    dismissSuggestion: () => setSuggestion(null),
    useMyLocation,
    locating,
    searchCities,
  };
}

/**
 * One city preference for the whole app.
 *
 * A context rather than a hook per component: the header chip and the page doing the
 * filtering must agree, and two independent `useCityPreference()` calls would each keep
 * their own state and each fire their own resolve — so picking a city in the header would
 * visibly fail to change the page.
 */
const CityContext = createContext<CityPreference | null>(null);

export function CityProvider({ children }: { children: React.ReactNode }) {
  const preference = useCityPreference();
  return <CityContext.Provider value={preference}>{children}</CityContext.Provider>;
}

/**
 * The app's city preference.
 *
 * Falls back to "everywhere, and nothing to pick from" outside a provider rather than
 * throwing — a missing city filter is a smaller problem than a page that will not render,
 * and this keeps the picker safe to drop into an app that has not adopted the provider.
 */
export function useCity(): CityPreference {
  return (
    useContext(CityContext) ?? {
      city: null,
      country: null,
      topCities: [],
      suggestion: null,
      chosen: false,
      setCity: () => undefined,
      clearCity: () => undefined,
      dismissSuggestion: () => undefined,
      useMyLocation: async () => undefined,
      locating: false,
      searchCities: async () => [],
    }
  );
}

/**
 * What the storefront should ask the API for, given where the customer is.
 *
 * One place, because the answer has to be identical on the home page, on Browse and on
 * Movies — and it was not: the home page ignored the preference entirely, so choosing
 * Bengaluru in the header changed Browse and left the homepage showing Mumbai. Three
 * pages each deciding this for themselves is three chances to disagree.
 */
export function cityScope(preference: CityPreference): { city?: string; country?: string } {
  if (preference.city) return { city: preference.city };
  if (preference.country) return { country: preference.country };
  return {};
}

/** How long after the last keystroke to ask the server. Short enough to feel immediate. */
const SEARCH_DEBOUNCE_MS = 180;

/**
 * The city control: where you are, and one box to change it.
 *
 * ── WHY THIS IS NOT A LIST ─────────────────────────────────────────────────────────
 * It used to render every sellable city, grouped by country. That works at six and fails
 * at a hundred in three separate ways: the panel becomes a scroll nobody reads, finding
 * your own city takes longer than typing it, and — the one that actually looked broken —
 * a list of every city the platform sells in is a public inventory of how small the
 * platform is. Two of the six cities on QA were a typo and a test row, and the list put
 * them in front of every visitor.
 *
 * So: what is applied now, one button to detect it, and a box to type into. The handful of
 * cities offered before you type are the busiest near you, which is a shortcut rather than
 * a menu — and the escape to "All cities" stays, because a filter you cannot leave is a trap.
 */
export function CityPicker({
  preference,
  className = '',
  /*
    The "no city chosen" label, supplied by the caller.

    web-kit is shared with the organizer and admin consoles, which are English-only by
    design, so the component cannot reach for a translation catalogue of its own. The
    storefront passes its localised string; everything else keeps the default and changes
    not at all.
  */
  allCitiesLabel = 'All cities',
}: {
  preference?: CityPreference;
  className?: string;
  allCitiesLabel?: string;
}) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState('');
  const [results, setResults] = useState<SellableCity[] | null>(null);
  const [searching, setSearching] = useState(false);
  const [active, setActive] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const fromContext = useCity();
  const { city, country, topCities, setCity, useMyLocation, locating, searchCities } =
    preference ?? fromContext;

  // Debounced, and last-response-wins. Without the generation check a slow answer for "mu"
  // can land after the answer for "mumb" and repopulate the list with staler matches.
  const generation = useRef(0);
  useEffect(() => {
    const term = q.trim();
    if (!term) {
      setResults(null);
      setSearching(false);
      return;
    }
    const mine = ++generation.current;
    setSearching(true);
    const timer = setTimeout(() => {
      void searchCities(term).then((found) => {
        if (generation.current !== mine) return;
        setResults(found);
        setSearching(false);
        setActive(0);
      });
    }, SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [q, searchCities]);

  // Focus the box on open, so the control is usable from the keyboard without tabbing
  // through the buttons above it, and so typing works the instant it appears.
  useEffect(() => {
    if (open) inputRef.current?.focus();
    else {
      setQ('');
      setResults(null);
      setActive(0);
    }
  }, [open]);

  const shown = results ?? topCities;
  const label = city ?? allCitiesLabel;

  const choose = (next: string | null) => {
    setCity(next);
    setOpen(false);
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') {
      setOpen(false);
      return;
    }
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      setActive((i) => {
        const next = e.key === 'ArrowDown' ? i + 1 : i - 1;
        return Math.max(0, Math.min(shown.length - 1, next));
      });
      return;
    }
    if (e.key === 'Enter' && shown[active]) {
      e.preventDefault();
      choose(shown[active].city);
    }
  };

  return (
    <div className={`relative ${className}`}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        aria-haspopup="dialog"
        // The full value goes on the accessible name because the visible one truncates.
        aria-label={`Location: ${label}. Change`}
        className="flex items-center gap-1.5 rounded-md px-2.5 py-1.5 text-[0.9375rem] text-text-secondary transition-colors hover:bg-background-subtle hover:text-text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
      >
        <MapPin className="h-4 w-4 shrink-0" />
        {/*
          Narrower on a phone, because at 320px this label was the widest thing in the header.
          "Toutes les villes" is half again the length of "All cities", which is the general
          case: a translated string is not the same size as the one it replaces. It truncates
          rather than wraps — the chip has to stay one line.
        */}
        <span className="max-w-[5.5rem] truncate sm:max-w-[9rem]">{label}</span>
      </button>

      {open ? (
        <>
          {/* Click-away, not a focus trap: this is a filter, not a decision to defend. */}
          <div className="fixed inset-0 z-40" aria-hidden="true" onClick={() => setOpen(false)} />
          <div
            role="dialog"
            aria-label="Choose your location"
            onKeyDown={onKeyDown}
            className="absolute right-0 z-50 mt-2 w-[19rem] max-w-[calc(100vw-2rem)] overflow-hidden rounded-lg border border-border bg-background-surface shadow-lg"
          >
            {/* Where you are now, stated before anything asks you to change it. */}
            <div className="flex items-center gap-2 border-b border-border bg-background-subtle px-3 py-2.5">
              <MapPin className="h-4 w-4 shrink-0 text-action-primary" />
              <div className="min-w-0 flex-1">
                <p className="truncate text-[0.9375rem] font-medium text-text-primary">{label}</p>
                <p className="truncate text-caption text-text-muted">
                  {city
                    ? 'Showing events near you'
                    : country
                      ? `Showing events across ${country}`
                      : 'Showing events everywhere'}
                </p>
              </div>
              {city ? (
                <button
                  type="button"
                  onClick={() => choose(null)}
                  aria-label="Clear location and show all cities"
                  className="rounded-md p-1 text-text-muted transition-colors hover:bg-background-surface hover:text-text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
                >
                  <X className="h-4 w-4" />
                </button>
              ) : null}
            </div>

            {typeof navigator !== 'undefined' && navigator.geolocation ? (
              <button
                type="button"
                disabled={locating}
                onClick={async () => {
                  await useMyLocation();
                  setOpen(false);
                }}
                className="flex w-full items-center gap-2 border-b border-border px-3 py-2.5 text-left text-[0.9375rem] font-medium text-action-primary transition-colors hover:bg-background-subtle disabled:opacity-60"
              >
                {locating ? (
                  <Loader2 className="h-4 w-4 shrink-0 animate-spin" />
                ) : (
                  <Crosshair className="h-4 w-4 shrink-0" />
                )}
                {locating ? 'Finding you…' : 'Use my current location'}
              </button>
            ) : null}

            <div className="relative border-b border-border">
              <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-text-muted" />
              <input
                ref={inputRef}
                type="text"
                role="combobox"
                aria-expanded="true"
                aria-controls="city-results"
                aria-autocomplete="list"
                aria-label="Search for a city"
                value={q}
                onChange={(e) => setQ(e.target.value)}
                placeholder="Search for a city…"
                className="w-full bg-transparent py-2.5 pl-9 pr-3 text-[0.9375rem] text-text-primary placeholder:text-text-muted focus:outline-none"
              />
            </div>

            <ul id="city-results" role="listbox" className="max-h-64 overflow-auto p-1.5">
              {/* Named, so the shortlist before you type is not mistaken for all of them. */}
              {!results && shown.length > 0 ? (
                <li
                  aria-hidden="true"
                  className="px-2.5 pb-1 pt-1.5 text-caption font-medium uppercase tracking-wide text-text-muted"
                >
                  Popular near you
                </li>
              ) : null}

              {shown.map((c, i) => (
                <li key={`${c.country}-${c.city}`} role="option" aria-selected={city === c.city}>
                  <button
                    type="button"
                    onClick={() => choose(c.city)}
                    onMouseEnter={() => setActive(i)}
                    className={`flex w-full items-center gap-2 rounded-md px-2.5 py-2 text-left text-[0.9375rem] text-text-primary transition-colors ${
                      i === active ? 'bg-background-subtle' : ''
                    }`}
                  >
                    <span className="min-w-0 flex-1 truncate">
                      {c.city}
                      {/* The country disambiguates: more than one place is called Springfield. */}
                      <span className="ml-1.5 text-caption text-text-muted">{c.country}</span>
                    </span>
                    {/* The count is the honest reason to pick one city over another. */}
                    <span className="shrink-0 text-caption text-text-muted">{c.eventCount}</span>
                    {city === c.city ? (
                      <Check className="h-4 w-4 shrink-0 text-action-primary" />
                    ) : null}
                  </button>
                </li>
              ))}

              {q.trim() && !searching && shown.length === 0 ? (
                <li className="px-2.5 py-3 text-caption text-text-muted">
                  {/*
                    Names the reason. A city with nothing on sale is not a city we are
                    hiding — it is a city with nothing on sale, and saying so stops the
                    customer retyping it.
                  */}
                  No cities matching &ldquo;{q.trim()}&rdquo; have events on sale.
                </li>
              ) : null}

              {!q.trim() && shown.length === 0 ? (
                <li className="px-2.5 py-3 text-caption text-text-muted">
                  No cities with events on sale yet.
                </li>
              ) : null}
            </ul>

            {/* The way out, last and quiet — always available, never the headline. */}
            <button
              type="button"
              onClick={() => choose(null)}
              className="flex w-full items-center gap-2 border-t border-border px-3 py-2.5 text-left text-[0.9375rem] text-text-secondary transition-colors hover:bg-background-subtle"
            >
              <Globe className="h-4 w-4 shrink-0 text-text-muted" />
              <span className="flex-1">Browse all cities</span>
              {city === null ? <Check className="h-4 w-4 text-action-primary" /> : null}
            </button>
          </div>
        </>
      ) : null}
    </div>
  );
}

/**
 * The "looks like you're in X" bar.
 *
 * Shown only for a guess we chose not to apply, and it offers both answers — accepting is
 * one click, and so is picking somewhere else. A banner that only offers "yes" is a banner
 * that gets dismissed.
 */
export function CitySuggestionBar({ preference }: { preference?: CityPreference }) {
  const fromContext = useCity();
  const { suggestion, setCity, dismissSuggestion } = preference ?? fromContext;
  const suggested = suggestion?.city;
  const nearby = useMemo(
    () => (suggestion?.topCities ?? []).filter((c) => c.city !== suggested).slice(0, 3),
    [suggestion, suggested],
  );
  if (!suggested) return null;

  return (
    <div
      role="status"
      className="flex flex-wrap items-center justify-center gap-x-3 gap-y-1.5 border-b border-border bg-background-subtle px-4 py-2 text-[0.9375rem] text-text-secondary"
    >
      <span className="flex items-center gap-1.5">
        <MapPin className="h-4 w-4 shrink-0 text-text-muted" />
        Looks like you&apos;re near <strong className="text-text-primary">{suggested}</strong>.
      </span>
      <span className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          onClick={() => setCity(suggested)}
          className="rounded-md px-2 py-0.5 font-medium text-action-primary underline-offset-2 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
        >
          Show me {suggested}
        </button>
        {/*
          The other cities near them, right here.

          "Not now" was the only alternative, which makes the bar a yes/no question about a
          guess — and the answer to a wrong guess is rarely "everywhere", it is "no, the
          next city over".
        */}
        {nearby.map((c) => (
          <button
            key={c.city}
            type="button"
            onClick={() => setCity(c.city)}
            className="rounded-md px-2 py-0.5 text-text-secondary underline-offset-2 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
          >
            {c.city}
          </button>
        ))}
        <button
          type="button"
          onClick={dismissSuggestion}
          className="rounded-md px-2 py-0.5 text-text-muted underline-offset-2 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
        >
          Not now
        </button>
      </span>
    </div>
  );
}
