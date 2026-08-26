import { render, waitFor, act } from '@testing-library/react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import React from 'react';
import { useCityPreference } from '../api';

/** In-memory AsyncStorage. The real module is a native shim with no JS fallback. */
// jest hoists mock factories above this declaration, so the name needs the `mock` prefix
// jest whitelists.
/*
  React needs telling it is in a test before `act` will work.

  `render` sets this for itself, which is why every other spec here gets away without it —
  `renderHook` does not, and without it every state update from the hook's effects warns and
  the hook never settles.
*/
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const mockStore = new Map<string, string>();
jest.mock('@react-native-async-storage/async-storage', () => ({
  __esModule: true,
  default: {
    getItem: jest.fn(async (k: string) => mockStore.get(k) ?? null),
    setItem: jest.fn(async (k: string, v: string) => void mockStore.set(k, v)),
    removeItem: jest.fn(async (k: string) => void mockStore.delete(k)),
    clear: jest.fn(async () => void mockStore.clear()),
  },
}));

/**
 * Which city the customer is shopping in, on a phone.
 *
 * The rule this file exists to pin: on mobile the app NEVER applies a guess on its own. It
 * has only the device's configured region and the network the request arrived on, and
 * neither knows where the phone actually is — a region says where it was set up, an IP says
 * where the carrier egresses. Filtering somebody's homepage on either would hide events
 * they can reach without ever telling them why.
 *
 * So a guess is offered and a choice is obeyed, and these tests are written to fail if that
 * ever inverts.
 */

const resolved = {
  country: 'IN',
  city: 'Mumbai',
  source: 'network' as const,
  confident: false,
  cities: [
    { city: 'Mumbai', country: 'India', eventCount: 4 },
    { city: 'Bengaluru', country: 'India', eventCount: 2 },
  ],
};

jest.mock('@/services/http', () => ({
  getParsed: jest.fn(async () => resolved),
}));

jest.mock('@/services/locale', () => ({
  deviceLocale: { region: 'IN', tag: 'en-IN', timeZone: 'Asia/Kolkata' },
}));

/**
 * Drive the hook through a throwaway component instead of `renderHook`.
 *
 * RNTL's `renderHook` returns an empty object under this preset — no `result`, no
 * `rerender` — so every assertion against it reads `undefined.current`. `render` works
 * (every other spec here uses it), so the hook is mounted inside a component that does
 * nothing but publish what it returned.
 */
function mount() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  const seen: { current: ReturnType<typeof useCityPreference> | null } = { current: null };

  function Probe() {
    seen.current = useCityPreference();
    return null;
  }

  render(React.createElement(QueryClientProvider, { client }, React.createElement(Probe)));
  return seen as { current: ReturnType<typeof useCityPreference> };
}

describe('useCityPreference', () => {
  beforeEach(async () => {
    await AsyncStorage.clear();
    jest.clearAllMocks();
  });

  it('offers the guess instead of applying it', async () => {
    const result = mount();

    await waitFor(() => expect(result.current.ready).toBe(true));
    await waitFor(() => expect(result.current.suggestion).not.toBeNull());

    // Offered…
    expect(result.current.suggestion?.city).toBe('Mumbai');
    // …and emphatically NOT applied. Nothing is filtered until the customer says so.
    expect(result.current.city).toBeNull();
  });

  it('applies a city the customer picks, and remembers it', async () => {
    const result = mount();
    await waitFor(() => expect(result.current.ready).toBe(true));

    await act(async () => {
      result.current.setCity('Bengaluru');
    });

    expect(result.current.city).toBe('Bengaluru');
    // Written through, so the next launch does not start guessing again.
    await waitFor(async () => expect(await AsyncStorage.getItem('etg.city')).toBe('Bengaluru'));
  });

  it('stops suggesting once a choice has been made', async () => {
    const result = mount();
    await waitFor(() => expect(result.current.suggestion).not.toBeNull());

    await act(async () => {
      result.current.setCity('Bengaluru');
    });

    // Continuing to offer Mumbai after they chose Bengaluru would read as the app arguing.
    expect(result.current.suggestion).toBeNull();
  });

  it('treats "everywhere" as a real choice and remembers it too', async () => {
    /*
      The subtle one.

      Storing null for "all cities" is indistinguishable from having no preference, so the
      next launch would suggest a city at somebody who has already said they want everything.
      A sentinel is stored instead, and read back as null.
    */
    const result = mount();
    await waitFor(() => expect(result.current.ready).toBe(true));

    await act(async () => {
      result.current.setCity(null);
    });

    expect(result.current.city).toBeNull();
    await waitFor(async () => expect(await AsyncStorage.getItem('etg.city')).toBe('__all__'));
    expect(result.current.suggestion).toBeNull();
  });

  it('honours a stored choice and never re-guesses over it', async () => {
    await AsyncStorage.setItem('etg.city', 'Bengaluru');

    const result = mount();
    await waitFor(() => expect(result.current.ready).toBe(true));
    await waitFor(() => expect(result.current.city).toBe('Bengaluru'));

    // The server still guesses Mumbai. It must not surface: their answer already stands.
    expect(result.current.suggestion).toBeNull();
  });

  it('reads a stored "everywhere" back as everywhere, not as a city called __all__', async () => {
    await AsyncStorage.setItem('etg.city', '__all__');

    const result = mount();
    await waitFor(() => expect(result.current.ready).toBe(true));

    expect(result.current.city).toBeNull();
    expect(result.current.suggestion).toBeNull();
  });

  it('offers the cities to choose from', async () => {
    const result = mount();
    await waitFor(() => expect(result.current.cities).toHaveLength(2));
    expect(result.current.cities.map((c) => c.city)).toEqual(['Mumbai', 'Bengaluru']);
  });

  it('dismissing the suggestion leaves the customer browsing everywhere', async () => {
    const result = mount();
    await waitFor(() => expect(result.current.suggestion).not.toBeNull());

    await act(async () => {
      result.current.dismissSuggestion();
    });

    expect(result.current.suggestion).toBeNull();
    // "Not now" is not "no, and filter me to Mumbai anyway".
    expect(result.current.city).toBeNull();
  });
});
