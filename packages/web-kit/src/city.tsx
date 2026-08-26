'use client';

import { createContext, useCallback, useContext, useEffect, useState } from 'react';
import { MapPin, Check, Crosshair, Globe } from 'lucide-react';
import { api, type ResolvedLocation, type SellableCity } from './api';

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
 *      meantime show everything. Never an empty page while we work out where they are.
 *
 * The city is kept on the device rather than the account. Someone who travels wants the
 * city they are in, not the one they picked at home last month, and a per-device choice
 * gets that right without anyone having to think about it.
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
  /** Cities with something on sale. Empty until the first resolve returns. */
  cities: SellableCity[];
  /** A guess we have not applied, worth offering. Null once accepted or dismissed. */
  suggestion: ResolvedLocation | null;
  /** Whether the person has made an explicit choice (so nothing should be suggested). */
  chosen: boolean;
  setCity: (city: string | null) => void;
  dismissSuggestion: () => void;
  /** Ask the browser for coordinates. Only ever call from a click. */
  useMyLocation: () => Promise<void>;
  locating: boolean;
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
  const [cities, setCities] = useState<SellableCity[]>([]);
  const [suggestion, setSuggestion] = useState<ResolvedLocation | null>(null);
  const [locating, setLocating] = useState(false);

  useEffect(() => {
    let cancelled = false;
    // Always resolve, even when a city is already chosen — the city LIST is needed for the
    // picker either way, and one call gets both.
    api.location
      .resolve()
      .then((result) => {
        if (cancelled) return;
        setCities(result.cities);
        if (readStoredCity() !== null) return; // their choice stands
        if (result.confident && result.city) {
          setCityState(result.city);
          // Deliberately NOT persisted and NOT marked chosen: applying a guess is not the
          // same as the person picking, and next visit deserves a fresh look.
          return;
        }
        if (result.city || result.country) setSuggestion(result);
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
    // "All cities" is a real choice and is remembered as one — storing null would make the
    // next visit guess again at somebody who already said they wanted everything.
    writeStoredCity(next ?? ALL_CITIES);
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
      setCities(result.cities);
      // Coordinates come from a button press, so this IS their choice — persisted as one.
      if (result.city) setCity(result.city);
    } catch {
      // Declined, timed out, or nowhere near a city we serve. The picker is still open.
    } finally {
      setLocating(false);
    }
  }, [setCity]);

  return {
    // A stored '__all__' means everywhere, explicitly.
    city: city === ALL_CITIES ? null : city,
    cities,
    suggestion,
    chosen,
    setCity,
    dismissSuggestion: () => setSuggestion(null),
    useMyLocation,
    locating,
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
      cities: [],
      suggestion: null,
      chosen: false,
      setCity: () => undefined,
      dismissSuggestion: () => undefined,
      useMyLocation: async () => undefined,
      locating: false,
    }
  );
}

/**
 * The city control: what is applied now, and everything it could be.
 *
 * Rendered as a chip rather than a select because the current city has to be readable at a
 * glance from every page — a customer who does not notice they are filtered to Delhi will
 * report the Mumbai show as missing.
 */
export function CityPicker({
  preference,
  className = '',
}: {
  preference?: CityPreference;
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  const fromContext = useCity();
  const { city, cities, setCity, useMyLocation, locating } = preference ?? fromContext;

  // Grouped by country, because the same city name exists in more than one and a flat list
  // makes a two-market platform look like a mistake.
  const byCountry = new Map<string, SellableCity[]>();
  for (const c of cities) {
    const list = byCountry.get(c.country) ?? [];
    list.push(c);
    byCountry.set(c.country, list);
  }

  return (
    <div className={`relative ${className}`}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        aria-haspopup="dialog"
        className="flex items-center gap-1.5 rounded-md px-2.5 py-1.5 text-[0.9375rem] text-text-secondary transition-colors hover:bg-background-subtle hover:text-text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
      >
        <MapPin className="h-4 w-4 shrink-0" />
        <span className="max-w-[9rem] truncate">{city ?? 'All cities'}</span>
      </button>

      {open ? (
        <>
          {/* Click-away, not a focus trap: this is a filter, not a decision to defend. */}
          <div className="fixed inset-0 z-40" aria-hidden="true" onClick={() => setOpen(false)} />
          <div
            role="dialog"
            aria-label="Choose your city"
            className="absolute right-0 z-50 mt-2 max-h-[70vh] w-64 overflow-auto rounded-lg border border-border bg-background-surface p-1.5 shadow-lg"
          >
            {typeof navigator !== 'undefined' && navigator.geolocation ? (
              <button
                type="button"
                disabled={locating}
                onClick={async () => {
                  await useMyLocation();
                  setOpen(false);
                }}
                className="flex w-full items-center gap-2 rounded-md px-2.5 py-2 text-left text-[0.9375rem] text-action-primary transition-colors hover:bg-background-subtle disabled:opacity-60"
              >
                <Crosshair className="h-4 w-4 shrink-0" />
                {locating ? 'Finding you…' : 'Use my location'}
              </button>
            ) : null}

            <button
              type="button"
              onClick={() => {
                setCity(null);
                setOpen(false);
              }}
              className="flex w-full items-center gap-2 rounded-md px-2.5 py-2 text-left text-[0.9375rem] text-text-primary transition-colors hover:bg-background-subtle"
            >
              <Globe className="h-4 w-4 shrink-0 text-text-muted" />
              <span className="flex-1">All cities</span>
              {city === null ? <Check className="h-4 w-4 text-action-primary" /> : null}
            </button>

            {cities.length === 0 ? (
              <p className="px-2.5 py-2 text-caption text-text-muted">
                No cities with events on sale yet.
              </p>
            ) : (
              [...byCountry.entries()].map(([country, list]) => (
                <div key={country}>
                  <p className="px-2.5 pb-1 pt-2 text-caption font-medium uppercase tracking-wide text-text-muted">
                    {country}
                  </p>
                  {list.map((c) => (
                    <button
                      key={`${country}-${c.city}`}
                      type="button"
                      onClick={() => {
                        setCity(c.city);
                        setOpen(false);
                      }}
                      className="flex w-full items-center gap-2 rounded-md px-2.5 py-2 text-left text-[0.9375rem] text-text-primary transition-colors hover:bg-background-subtle"
                    >
                      <span className="flex-1 truncate">{c.city}</span>
                      {/* The count is the honest reason to pick one city over another. */}
                      <span className="text-caption text-text-muted">{c.eventCount}</span>
                      {city === c.city ? <Check className="h-4 w-4 text-action-primary" /> : null}
                    </button>
                  ))}
                </div>
              ))
            )}
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
  if (!suggestion?.city) return null;

  return (
    <div
      role="status"
      className="flex flex-wrap items-center justify-center gap-x-3 gap-y-1.5 border-b border-border bg-background-subtle px-4 py-2 text-[0.9375rem] text-text-secondary"
    >
      <span className="flex items-center gap-1.5">
        <MapPin className="h-4 w-4 shrink-0 text-text-muted" />
        Looks like you&apos;re near <strong className="text-text-primary">{suggestion.city}</strong>
        .
      </span>
      <span className="flex items-center gap-2">
        <button
          type="button"
          onClick={() => setCity(suggestion.city)}
          className="rounded-md px-2 py-0.5 font-medium text-action-primary underline-offset-2 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
        >
          Show me {suggestion.city}
        </button>
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
