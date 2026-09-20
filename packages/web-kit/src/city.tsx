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
import { MARKETS } from '@eticketsgo/shared-types';
import { api, type ResolvedLocation, type SellableCity } from './api';
import { visitorCountry } from './locale';

/**
 * "US" is not a thing to say to a person. Falls back to the code when we are scoped to
 * somewhere that is not one of our declared markets, which is better than printing nothing.
 *
 * Exported because the storefront pages need it too: now that discovery scopes to the
 * visitor's country whether or not we sell there, "Nothing on in US just yet" is a line real
 * customers read, not an edge case.
 */
export function countryName(code: string): string {
  return MARKETS.find((m) => m.code === code.toUpperCase())?.name ?? code;
}

/**
 * The same country, fit to drop into the middle of a sentence.
 *
 * "Showing events in United States" is not English, and three of our eight markets have this
 * problem — the United States, the United Kingdom, the United Arab Emirates. The country
 * scope is read back to the customer in a sentence on the homepage, on Browse, on Movies and
 * inside the picker, so this is not a detail: it is the grammar of the most-seen line on an
 * empty storefront, and getting it wrong is exactly the "clearly written by a machine"
 * texture we have had feedback about.
 *
 * A prefix test rather than a list of exceptions, because the article belongs to the SHAPE of
 * the name — a country called "the United Something" always takes one — and a list would need
 * editing every time a market is added by somebody not thinking about grammar.
 */
export function countryPhrase(code: string): string {
  const name = countryName(code);
  return name.startsWith('United ') ? `the ${name}` : name;
}

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

/**
 * ── WHY THERE IS NO "BROWSE EVERY COUNTRY" ─────────────────────────────────────────
 * There briefly was one, added on the reasoning that a scope needs an escape hatch. The
 * owner's judgement, and it is the right one: somebody in the United States has no use for a
 * list of Indian events, and neither does somebody in India for American ones. A control
 * offering "everywhere" is not a way out, it is a way to a page of things you cannot attend.
 *
 * The way to look somewhere else is to SEARCH for the city — which is a deliberate act with
 * a specific place in mind, and is how a person actually thinks about it. That is why
 * `searchCities` below is not scoped to the visitor's country: the search box IS the escape
 * hatch, so it must find a city anywhere, and every result names its country.
 */

export interface CityPreference {
  /** The city to filter by, or null for everywhere. */
  city: string | null;
  /**
   * The country to scope to when no city is chosen, or null when we do not know where they
   * are. Kept even when the customer picks "All cities", which means every city in their
   * country and not every city on earth.
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
   * `null` here means every city IN THE COUNTRY we believe they are in — it is what the
   * picker's "All cities in India" does, and it keeps the country. To forget the stored
   * choice entirely and let the next visit guess again, call `clearCity()`.
   *
   * This doc used to say the opposite, that choosing everywhere dropped the country too.
   * The implementation had already stopped doing that, for the reason written beside it: a
   * storefront in the United States leading with events in Mumbai reads as broken. Left
   * uncorrected, the comment was an invitation to "fix" the code back. The control it
   * describes is labelled with the country now, so nothing has to be inferred from the word
   * "all"; leaving the country is done by searching for a city, not by a button.
   */
  setCity: (city: string | null) => void;
  /** Stop filtering by city, keeping the country scope and forgetting the stored choice. */
  clearCity: () => void;
  /**
   * Ask the header's picker to open, with the search box focused.
   *
   * So a page that is empty because of WHERE can hand the person the one control that fixes
   * it, instead of describing a box in the corner and hoping they find it. A counter rather
   * than a boolean: two presses in a row must both open it, and the picker owns its own
   * closing.
   */
  requestPicker: () => void;
  /** Incremented by `requestPicker`. The picker watches this; nothing else should. */
  pickerRequests: number;
  /**
   * Why the last "use my current location" did not apply anything, or null.
   *
   * It used to fail in complete silence — the panel simply closed. A permission the browser
   * refused and a coordinate fix that matched no city look identical from the outside, and
   * both look like a broken button.
   */
  locateError: 'refused' | 'no-city' | null;
  dismissSuggestion: () => void;
  /**
   * Ask the browser for coordinates. Only ever call from a click.
   *
   * Reports what happened so the caller can decide whether to close the panel. It used to
   * return nothing and the panel closed either way, so a refused permission and a successful
   * fix were the same gesture from the outside — which is what made the button look dead.
   */
  useMyLocation: () => Promise<'applied' | 'no-city' | 'refused'>;
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
  const [locateError, setLocateError] = useState<'refused' | 'no-city' | null>(null);
  const [pickerRequests, setPickerRequests] = useState(0);

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
        /*
          The country scope is applied FIRST, and applies even to a stored "all cities".

          It used to return early here, on the reading that somebody who asked for everywhere
          meant the whole world. In practice "all cities" is how people stop filtering by ONE
          city, not how they ask to be shown another continent — and the result was a visitor
          in the United States being offered a comedy night in Hyderabad and a gig in Mumbai,
          eight thousand miles away, in a currency their card would be charged in.

          `scopeCountry` is the country we should FILTER by, and it is now set whether or not
          we sell there. It used to be withheld for a country with no inventory, which did not
          narrow the page but removed the filter — so the one visitor we had nothing for was
          the one shown everything. An empty country is an empty storefront that says so.
          When we do not know where somebody is at all, this stays null and the feed is
          unscoped, because there is nothing narrower to be.
        */
        setCountry(result.scopeCountry);
        if (readStoredCity() === ALL_CITIES) return;
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
    /*
      Clearing the city widens to the COUNTRY, not to the world -- so the country hint is
      deliberately left alone here.

      This used to drop it, on the reading that a control called "All cities" which still
      filtered by country would read as broken. The opposite turned out to be true: what
      reads as broken is a storefront in the United States leading with events in Mumbai and
      Hyderabad. Nobody clearing a city filter is asking to be shown another continent, and
      the panel says which country it is showing, so the control is not silently narrower
      than it claims.
    */
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

  const requestPicker = useCallback(() => setPickerRequests((n) => n + 1), []);

  const useMyLocation = useCallback(async (): Promise<'applied' | 'no-city' | 'refused'> => {
    if (!globalThis.navigator?.geolocation) return 'refused';
    setLocating(true);
    setLocateError(null);
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
        /*
          The region goes WITH the coordinates, and leaving it out was a real defect.

          Coordinates only ever resolve to a city through a cinema that has latitude and
          longitude on it, and almost none do — so for most people the coordinate lookup
          finds nothing. With no region alongside it the server then had no hint left at all
          and answered "we do not know", which does not mean "stay where you are": it clears
          the country and opens the storefront to the whole world. Pressing "use my current
          location" in New York therefore offered Hyderabad. The one button whose entire
          purpose is to put you where you are was the one way to be sent somewhere else.
        */
        region: visitorCountry() ?? undefined,
      });
      setTopCities(result.topCities);
      setCountry(result.scopeCountry);
      // Coordinates come from a button press, so this IS their choice — persisted as one.
      if (result.city) {
        setCity(result.city);
        return 'applied';
      }
      // Country but no city: honest, and worth saying, because the panel would otherwise
      // look like it had ignored the press. Common, because coordinates only ever resolve to
      // a city through a cinema carrying latitude and longitude, and almost none do.
      setLocateError('no-city');
      return 'no-city';
    } catch {
      // Refused, timed out, or no position available. All the same to the person: we asked
      // the browser and it would not say. The panel stays open and now explains itself.
      setLocateError('refused');
      return 'refused';
    } finally {
      setLocating(false);
    }
  }, [setCity]);

  /*
    Searching looks in the visitor's own country first, for the same reason the shortlist
    does: typing "hy" in the United States should not lead with Hyderabad.

    It widens only when the country search finds NOTHING, because the alternative is a trap.
    Somebody from Hyderabad opening this in a Chicago hotel knows exactly which city they
    want, and a box that refuses to find a place that plainly exists reads as broken rather
    than as principled. Every row names its country, so a widened answer is never mistaken
    for a local one.
  */
  /**
   * Prefix search over every sellable city, ANYWHERE — deliberately not scoped.
   *
   * This is the only way to shop outside the country we put you in, so it has to find the
   * place you have in mind wherever it is. It was briefly scoped to the visitor's country
   * with a widen-if-empty fallback, which is the worst of both: somebody in the United
   * States typing "Hyderabad" got it only because nothing American matched, so the same
   * keystrokes would stop working the day we sell a ticket in Houston.
   *
   * Every result names its country beside the city, so "Springfield" is still a choice
   * between places rather than a guess.
   */
  const searchCities = useCallback(
    async (q: string) => api.location.cities({ q, limit: 8 }).catch(() => []),
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
    requestPicker,
    pickerRequests,
    locateError,
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
      requestPicker: () => undefined,
      pickerRequests: 0,
      locateError: null,
      dismissSuggestion: () => undefined,
      useMyLocation: async () => 'refused' as const,
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

/**
 * Whether an event is inside the scope the customer is currently browsing in.
 *
 * ── WHY A CLIENT-SIDE TWIN OF `cityScope` IS NEEDED AT ALL ─────────────────────────
 * Every list on the storefront is filtered by the server, which is why choosing Meridian
 * correctly leaves Browse, Movies and the home page showing Meridian events only. One list
 * is not: "Continue exploring" is read from this browser's own history, so nothing filtered
 * it and it happily offered a Hyderabad comedy show and a Mumbai gig to somebody whose
 * header said Meridian.
 *
 * That is not a harmless leftover. "Continue exploring" is an invitation to act, sitting
 * directly under a header naming a city — and the invitation was to a show eight thousand
 * miles away. Worse, it made the scoping look broken when it was working: the only events
 * on screen were the out-of-scope ones.
 *
 * The rule matches `cityScope` exactly, because a page that filters its server lists one way
 * and its local list another is back to two answers for one question.
 */
export function inCityScope(
  event: { venue?: { city?: string | null; country?: string | null } | null },
  preference: CityPreference,
): boolean {
  const venue = event.venue;
  // No venue means nothing to compare. Keep it rather than hide it: an event we cannot
  // place is not evidence that it is somewhere else.
  if (!venue) return true;

  const same = (a?: string | null, b?: string | null) =>
    Boolean(a?.trim() && b?.trim() && a.trim().toLowerCase() === b.trim().toLowerCase());

  if (preference.city) return same(venue.city, preference.city);
  if (preference.country) return same(venue.country, preference.country);
  // No preference at all — nothing is out of scope.
  return true;
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
  const {
    city,
    country,
    topCities,
    setCity,
    useMyLocation,
    locating,
    locateError,
    pickerRequests,
    searchCities,
  } = preference ?? fromContext;

  /*
    An empty page elsewhere can ask this panel to open — see `requestPicker`. Skipped on the
    first render, where the counter is still 0 and nobody has asked for anything.
  */
  useEffect(() => {
    if (pickerRequests > 0) setOpen(true);
  }, [pickerRequests]);

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

  /*
    Escape closes it from wherever focus happens to be.

    The panel's own `onKeyDown` only fires for keys pressed INSIDE it, and this is not a
    focus trap on purpose — it is a filter, not a decision to defend. So focus can legally
    sit outside while the panel is open, and there Escape did nothing at all: the overlay
    swallowed clicks and the keyboard had no answer, which is a panel you cannot leave
    without a mouse.
  */
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    globalThis.addEventListener?.('keydown', onKey);
    return () => globalThis.removeEventListener?.('keydown', onKey);
  }, [open]);

  const shown = results ?? topCities;
  /*
    The chip names the scope it is actually applying.

    With no city but a known country the feed is that country, and saying "All cities" there
    invites exactly the question this change came from -- why am I being shown another
    country? The country name is no longer than the label it replaces, which matters: this
    chip is the widest thing in the header at 320px.
  */
  const label = city ?? (country ? countryName(country) : allCitiesLabel);

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
                      ? `Showing events across ${countryPhrase(country)}`
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
                  // Closed only when the answer changed something. Closing on a refusal hides
                  // the explanation the person needs and looks exactly like a dead button.
                  if ((await useMyLocation()) === 'applied') setOpen(false);
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

            {/*
              What happened, in the panel that is still open because of it.

              Stated and no more. What to do next is already on screen — the search box sits
              directly under this, and where the country has nothing the line below says so
              and names the box. Repeating "search for a city" twice in four inches is how a
              panel starts to sound like it is apologising.
            */}
            {locateError && !locating ? (
              <p
                role="status"
                className="border-b border-border bg-background-subtle px-3 py-2.5 text-caption text-text-secondary"
              >
                {locateError === 'refused'
                  ? 'Your browser did not share your location.'
                  : 'We could not find one of our cities near you.'}
              </p>
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

              {/*
                Said plainly, because the alternative is a panel that looks like it failed to
                load. Scoping to a country we do not sell in yet is correct and it is not
                obvious, so the picker says so and points at the box directly above it.
              */}
              {!results && shown.length === 0 && country ? (
                <li className="px-2.5 py-3 text-[0.9375rem] text-text-secondary">
                  We have nothing on sale in {countryPhrase(country)} yet. To look somewhere else,
                  search for the city above.
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

              {/*
                Only when there is no country to blame it on. With one, the line above has
                already explained the same emptiness in more useful words, and printing both
                reads as the panel arguing with itself.
              */}
              {!q.trim() && shown.length === 0 && !country ? (
                <li className="px-2.5 py-3 text-caption text-text-muted">
                  No cities with events on sale yet.
                </li>
              ) : null}
            </ul>

            {/*
              ONE way out, last and quiet — never the headline.

              It widens to the country and stops there. There is deliberately no "every
              country" beneath it: a person in the United States has no use for a page of
              Indian events, and offering it as the remedy for an empty storefront sends them
              somewhere they cannot buy a ticket. Looking abroad is a deliberate act with a
              place already in mind, which is what the search box above is for.
            */}
            <button
              type="button"
              onClick={() => choose(null)}
              className="flex w-full items-center gap-2 border-t border-border px-3 py-2.5 text-left text-[0.9375rem] text-text-secondary transition-colors hover:bg-background-subtle"
            >
              <Globe className="h-4 w-4 shrink-0 text-text-muted" />
              <span className="flex-1">
                {country ? `All cities in ${countryPhrase(country)}` : 'All cities'}
              </span>
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
