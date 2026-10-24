import AsyncStorage from '@react-native-async-storage/async-storage';
import { useQuery } from '@tanstack/react-query';
import { useCallback, useEffect } from 'react';
import { create } from 'zustand';
import { z } from 'zod';
import { getParsed } from '@/services/http';
import { deviceLocale } from '@/services/locale';

/**
 * Which city the customer is shopping in, on a phone.
 *
 * ── WHY THIS IS NOT expo-location ──────────────────────────────────────────────────
 * The obvious move is a GPS permission prompt on first launch, and it is the wrong one for
 * two reasons. It costs a native module and therefore a new build for every store release,
 * and — the real reason — a permission prompt before the customer has seen a single event
 * is the fastest way to get told no, permanently. iOS gives one chance.
 *
 * So the phone uses the two signals it already has for free: the device's configured region
 * (`expo-localization`, already a dependency) and the network the request arrives on, which
 * the server reads. Neither needs permission and neither is precise, which is exactly why
 * the answer is offered rather than applied — see the web's `useCityPreference`, which makes
 * the same call for the same reason so the two clients behave identically.
 *
 * If precise location is wanted later, the server side already accepts coordinates: add
 * expo-location, send lat/lng, and the answer comes back `confident` and applies itself.
 */
const STORAGE_KEY = 'etg.city';

/** Stored when the customer deliberately chose everywhere, so we stop suggesting. */
const ALL_CITIES = '__all__';

export const sellableCitySchema = z.object({
  city: z.string(),
  country: z.string(),
  eventCount: z.number(),
});

/**
 * ── THIS SCHEMA HAD DRIFTED FROM THE ENDPOINT ──────────────────────────────────────
 * It still asked for `cities`, which the API renamed to `topCities` when the response
 * stopped being every sellable city and became a short list to offer — and a required Zod
 * field that is never sent makes `getParsed` throw, so this call could only ever fail.
 * Nothing noticed because nothing on a screen imports this module yet.
 *
 * `scopeCountry` is the other half and is the one that carries the rule: the country to
 * filter by, set whether or not we sell there. Whoever wires this into a screen must apply
 * it — the phone showing a customer in the United States a comedy night in Hyderabad is the
 * exact defect the web side was just fixed for.
 */
export const resolvedLocationSchema = z.object({
  country: z.string().nullable(),
  city: z.string().nullable(),
  source: z.enum(['coordinates', 'network', 'device-region', 'none']),
  confident: z.boolean(),
  scopeCountry: z.string().nullable(),
  topCities: z.array(sellableCitySchema),
});

export type SellableCity = z.infer<typeof sellableCitySchema>;
export type ResolvedLocation = z.infer<typeof resolvedLocationSchema>;

export const locationKeys = {
  all: ['location'] as const,
  resolve: (region: string) => [...locationKeys.all, 'resolve', region] as const,
};

/**
 * Every city with something on sale, most events first; `q` narrows by name. The sheet
 * offers these as well as the nearby ones, because the nearby list is scoped to the country
 * the server resolved: a customer in the United States could not otherwise choose Bengaluru.
 */
export function useSellableCities(q: string, enabled: boolean) {
  const term = q.trim();
  return useQuery({
    queryKey: [...locationKeys.all, 'cities', term] as const,
    queryFn: () =>
      getParsed(
        '/public/location/cities',
        z.array(sellableCitySchema.extend({ countryCode: z.string().nullish() })),
        term ? { q: term } : undefined,
      ),
    enabled,
    staleTime: 10 * 60_000,
  });
}

/** The server's guess, with the device's region as the fallback hint. */
export function useResolvedLocation() {
  return useQuery({
    queryKey: locationKeys.resolve(deviceLocale.region),
    queryFn: () =>
      getParsed('/public/location/resolve', resolvedLocationSchema, {
        region: deviceLocale.region,
      }),
    // Where somebody is changes on the scale of a journey, not a screen.
    staleTime: 30 * 60_000,
  });
}

export interface CityPreference {
  /** The city to filter by, or null for everywhere. */
  city: string | null;
  /** A few cities worth offering. Named to match the endpoint, which caps it. */
  topCities: SellableCity[];
  /** A guess not yet applied, worth offering. Null once accepted, dismissed, or chosen. */
  suggestion: ResolvedLocation | null;
  /**
   * The country to scope to when no city is chosen, set whether or not we sell there
   * (the server's rule). Null until the server has answered.
   */
  scopeCountry: string | null;
  setCity: (city: string | null) => void;
  dismissSuggestion: () => void;
  /** False until storage has been read, so nothing renders a wrong city first. */
  ready: boolean;
}

/**
 * ONE preference for the whole app. It was per-hook state, so Home and Explore each kept
 * their own copy and a city chosen on one screen did not exist on the other. Loaded from
 * storage once, on first use.
 */
interface CityState {
  city: string | null;
  ready: boolean;
  chosen: boolean;
  dismissed: boolean;
  loading: boolean;
}

const initialCityState: CityState = {
  city: null,
  ready: false,
  chosen: false,
  dismissed: false,
  loading: false,
};

const useCityStore = create<CityState>(() => ({ ...initialCityState }));

/** Tests start each case from an empty store, as a fresh app launch would. */
export function resetCityStoreForTests(): void {
  useCityStore.setState({ ...initialCityState });
}

function loadStoredCity(): void {
  const state = useCityStore.getState();
  if (state.ready || state.loading) return;
  useCityStore.setState({ loading: true });
  AsyncStorage.getItem(STORAGE_KEY)
    .then((stored) => {
      if (stored) {
        useCityStore.setState({ city: stored === ALL_CITIES ? null : stored, chosen: true });
      }
    })
    .catch(() => {
      /* an unreadable preference is not worth a crash; browse everywhere */
    })
    .finally(() => useCityStore.setState({ ready: true, loading: false }));
}

export function useCityPreference(): CityPreference {
  const { city, ready, chosen, dismissed } = useCityStore();
  const resolved = useResolvedLocation();

  // AsyncStorage is genuinely async on a phone, so there is a moment where the stored city
  // is unknown. `ready` exists so a screen can wait rather than render "All cities" and
  // then visibly change its mind.
  useEffect(() => {
    loadStoredCity();
  }, []);

  const setCity = useCallback((next: string | null) => {
    useCityStore.setState({ city: next, chosen: true, dismissed: true });
    void AsyncStorage.setItem(STORAGE_KEY, next ?? ALL_CITIES).catch(() => {
      /* honoured for this session even if it cannot be persisted */
    });
  }, []);

  const guess = resolved.data ?? null;
  return {
    city,
    topCities: guess?.topCities ?? [],
    // Only ever a suggestion on mobile: neither the device region nor the network is
    // precise enough to silently filter what somebody sees.
    suggestion: !ready || chosen || dismissed || !guess?.city ? null : guess,
    scopeCountry: guess?.scopeCountry ?? null,
    setCity,
    dismissSuggestion: () => useCityStore.setState({ dismissed: true }),
    ready,
  };
}
