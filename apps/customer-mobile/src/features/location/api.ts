import AsyncStorage from '@react-native-async-storage/async-storage';
import { useQuery } from '@tanstack/react-query';
import { useCallback, useEffect, useState } from 'react';
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

export const resolvedLocationSchema = z.object({
  country: z.string().nullable(),
  city: z.string().nullable(),
  source: z.enum(['coordinates', 'network', 'device-region', 'none']),
  confident: z.boolean(),
  cities: z.array(sellableCitySchema),
});

export type SellableCity = z.infer<typeof sellableCitySchema>;
export type ResolvedLocation = z.infer<typeof resolvedLocationSchema>;

export const locationKeys = {
  all: ['location'] as const,
  resolve: (region: string) => [...locationKeys.all, 'resolve', region] as const,
};

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
  cities: SellableCity[];
  /** A guess not yet applied, worth offering. Null once accepted, dismissed, or chosen. */
  suggestion: ResolvedLocation | null;
  setCity: (city: string | null) => void;
  dismissSuggestion: () => void;
  /** False until storage has been read, so nothing renders a wrong city first. */
  ready: boolean;
}

export function useCityPreference(): CityPreference {
  const [city, setCityState] = useState<string | null>(null);
  const [ready, setReady] = useState(false);
  const [chosen, setChosen] = useState(false);
  const [dismissed, setDismissed] = useState(false);
  const resolved = useResolvedLocation();

  // AsyncStorage is genuinely async on a phone, so unlike the web there is a moment where
  // the stored city is unknown. `ready` exists so a screen can wait rather than render
  // "All cities" and then visibly change its mind.
  useEffect(() => {
    let cancelled = false;
    AsyncStorage.getItem(STORAGE_KEY)
      .then((stored) => {
        if (cancelled) return;
        if (stored) {
          setCityState(stored === ALL_CITIES ? null : stored);
          setChosen(true);
        }
      })
      .catch(() => {
        /* an unreadable preference is not worth a crash; browse everywhere */
      })
      .finally(() => {
        if (!cancelled) setReady(true);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const setCity = useCallback((next: string | null) => {
    setCityState(next);
    setChosen(true);
    setDismissed(true);
    void AsyncStorage.setItem(STORAGE_KEY, next ?? ALL_CITIES).catch(() => {
      /* honoured for this session even if it cannot be persisted */
    });
  }, []);

  const guess = resolved.data ?? null;
  return {
    city,
    cities: guess?.cities ?? [],
    // Only ever a suggestion on mobile: neither the device region nor the network is
    // precise enough to silently filter what somebody sees.
    suggestion: !ready || chosen || dismissed || !guess?.city ? null : guess,
    setCity,
    dismissSuggestion: () => setDismissed(true),
    ready,
  };
}
