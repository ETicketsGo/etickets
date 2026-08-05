import AsyncStorage from '@react-native-async-storage/async-storage';
import {
  MAX_CACHE_AGE_MS,
  clearAllTickets,
  clearTickets,
  describeFreshness,
  readTickets,
  saveTickets,
} from '../ticket-cache';
import type { Ticket } from '@/features/bookings/schema';

/** In-memory AsyncStorage. The real module is a native shim with no JS fallback. */
// jest hoists mock factories above this declaration, so the name needs the `mock`
// prefix jest whitelists.
const mockStore = new Map<string, string>();
jest.mock('@react-native-async-storage/async-storage', () => ({
  __esModule: true,
  default: {
    getItem: jest.fn(async (k: string) => mockStore.get(k) ?? null),
    setItem: jest.fn(async (k: string, v: string) => void mockStore.set(k, v)),
    removeItem: jest.fn(async (k: string) => void mockStore.delete(k)),
    getAllKeys: jest.fn(async () => [...mockStore.keys()]),
    multiRemove: jest.fn(async (ks: string[]) => ks.forEach((k) => mockStore.delete(k))),
  },
}));

const NOW = Date.UTC(2026, 7, 4, 12, 0, 0);
const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

function ticket(overrides: Partial<Ticket> = {}): Ticket {
  return {
    id: 't_1',
    serial: 'TKT-0001',
    status: 'VALID',
    holderName: 'Test Customer',
    ticketType: 'General',
    event: { title: 'Standup Night', slug: 'standup-night' },
    startsAt: new Date(NOW + 2 * DAY).toISOString(),
    qrToken: 'signed.credential.value',
    qrDataUrl: 'data:image/png;base64,iVBORw0KGgo=',
    bookingId: 'bk_1',
    bookingRef: 'ETG-IN-2026-000123',
    experienceType: 'EVENT',
    seatLabel: null,
    venueName: 'Phoenix Arena',
    screenName: null,
    cinemaName: null,
    assignmentStatus: 'ASSIGNED',
    attendeeName: 'Test Customer',
    ownedByViewer: true,
    assignedToViewer: true,
    ...overrides,
  };
}

beforeEach(() => {
  mockStore.clear();
  jest.clearAllMocks();
});

describe('what gets persisted', () => {
  it('never writes qrToken to disk', async () => {
    await saveTickets('user_a', [ticket()], NOW);

    const written = [...mockStore.values()].join('');
    // The credential the scanner verifies must not survive on the device; the picture
    // of it is all the app needs to show.
    expect(written).not.toContain('signed.credential.value');
    expect(written).toContain('data:image/png;base64');
  });

  it('preserves qrDataUrl byte for byte rather than regenerating it', async () => {
    const original = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAAB';
    await saveTickets('user_a', [ticket({ qrDataUrl: original })], NOW);

    const result = await readTickets('user_a', NOW);

    expect(result.status).toBe('ok');
    if (result.status !== 'ok') return;
    expect(result.tickets[0].qrDataUrl).toBe(original);
  });

  it('keeps only upcoming tickets', async () => {
    await saveTickets(
      'user_a',
      [
        ticket({ id: 'past', startsAt: new Date(NOW - DAY).toISOString() }),
        ticket({ id: 'future', startsAt: new Date(NOW + DAY).toISOString() }),
      ],
      NOW,
    );

    const result = await readTickets('user_a', NOW);

    expect(result.status).toBe('ok');
    if (result.status !== 'ok') return;
    expect(result.tickets.map((t) => t.id)).toEqual(['future']);
  });
});

describe('reading offline', () => {
  it('returns saved tickets with the sync time', async () => {
    await saveTickets('user_a', [ticket()], NOW);

    const result = await readTickets('user_a', NOW + HOUR);

    expect(result).toMatchObject({ status: 'ok', syncedAt: NOW });
  });

  it('reports empty when nothing was ever saved', async () => {
    expect(await readTickets('user_a', NOW)).toEqual({ status: 'empty' });
  });

  it('marks a cache older than the maximum age as stale but still returns it', async () => {
    await saveTickets(
      'user_a',
      [ticket({ startsAt: new Date(NOW + 30 * DAY).toISOString() })],
      NOW,
    );

    const result = await readTickets('user_a', NOW + MAX_CACHE_AGE_MS + HOUR);

    // Stale, not discarded: someone at a gate is better served by old data plus a
    // warning than by an empty screen.
    expect(result.status).toBe('stale');
    if (result.status !== 'stale') return;
    expect(result.tickets).toHaveLength(1);
  });

  it('drops tickets whose event passed while the cache sat unused', async () => {
    await saveTickets('user_a', [ticket({ startsAt: new Date(NOW + DAY).toISOString() })], NOW);

    const result = await readTickets('user_a', NOW + 3 * DAY);

    expect(result.status).toBe('ok');
    if (result.status !== 'ok') return;
    expect(result.tickets).toEqual([]);
  });

  it('restores after an app restart, reading only from disk', async () => {
    // Written by a "previous process": the bytes are in storage and this module has
    // never seen them. If readTickets kept anything in memory, this would come back
    // empty — which is exactly the failure mode that loses someone their ticket when
    // the OS kills a backgrounded app on the way to the venue.
    const { qrToken: _dropped, ...persisted } = ticket();
    mockStore.set(
      'etg.tickets.v1.user_a',
      JSON.stringify({ version: 1, userId: 'user_a', syncedAt: NOW, tickets: [persisted] }),
    );

    const result = await readTickets('user_a', NOW + HOUR);

    expect(result.status).toBe('ok');
    if (result.status !== 'ok') return;
    expect(result.tickets[0].serial).toBe('TKT-0001');
    expect(result.tickets[0].qrDataUrl).toBe('data:image/png;base64,iVBORw0KGgo=');
  });
});

describe('corrupt data', () => {
  it('reports corrupt and discards unparseable JSON', async () => {
    mockStore.set('etg.tickets.v1.user_a', '{"version":1,"tick');

    expect(await readTickets('user_a', NOW)).toEqual({ status: 'corrupt' });
    // Discarded, so it cannot fail forever.
    expect(mockStore.has('etg.tickets.v1.user_a')).toBe(false);
  });

  it('reports corrupt when the envelope does not match the schema', async () => {
    mockStore.set('etg.tickets.v1.user_a', JSON.stringify({ version: 99, tickets: 'nope' }));

    expect(await readTickets('user_a', NOW)).toEqual({ status: 'corrupt' });
  });

  it('refuses an envelope whose userId does not match the key', async () => {
    // Defence against a mis-keyed write handing one account another's tickets.
    mockStore.set(
      'etg.tickets.v1.user_a',
      JSON.stringify({ version: 1, userId: 'user_b', syncedAt: NOW, tickets: [] }),
    );

    expect(await readTickets('user_a', NOW)).toEqual({ status: 'corrupt' });
  });

  it('tolerates a ticket missing its QR image without losing the rest', async () => {
    // qrDataUrl is a required string in the contract, so a null one fails the envelope
    // and the cache is dropped — the screen then falls back to "reconnect to load".
    mockStore.set(
      'etg.tickets.v1.user_a',
      JSON.stringify({
        version: 1,
        userId: 'user_a',
        syncedAt: NOW,
        tickets: [{ ...ticket(), qrDataUrl: null }],
      }),
    );

    expect(await readTickets('user_a', NOW)).toEqual({ status: 'corrupt' });
  });
});

describe('account isolation', () => {
  it('never returns one user’s tickets to another', async () => {
    await saveTickets('user_a', [ticket({ id: 'a_ticket' })], NOW);
    await saveTickets('user_b', [ticket({ id: 'b_ticket' })], NOW);

    const a = await readTickets('user_a', NOW);
    const b = await readTickets('user_b', NOW);

    expect(a.status === 'ok' && a.tickets[0].id).toBe('a_ticket');
    expect(b.status === 'ok' && b.tickets[0].id).toBe('b_ticket');
  });

  it('clearTickets removes only the named user', async () => {
    await saveTickets('user_a', [ticket()], NOW);
    await saveTickets('user_b', [ticket()], NOW);

    await clearTickets('user_a');

    expect(await readTickets('user_a', NOW)).toEqual({ status: 'empty' });
    expect((await readTickets('user_b', NOW)).status).toBe('ok');
  });

  it('logout wipes every account’s cache on the device', async () => {
    await saveTickets('user_a', [ticket()], NOW);
    await saveTickets('user_b', [ticket()], NOW);

    await clearAllTickets();

    expect(await readTickets('user_a', NOW)).toEqual({ status: 'empty' });
    expect(await readTickets('user_b', NOW)).toEqual({ status: 'empty' });
  });

  it('writes nothing for an empty user id', async () => {
    await saveTickets('', [ticket()], NOW);
    expect(mockStore.size).toBe(0);
  });
});

describe('freshness label', () => {
  it.each([
    [0, 'Synced just now'],
    [5 * 60_000, 'Synced 5 minutes ago'],
    [60_000, 'Synced 1 minute ago'],
    [3 * HOUR, 'Synced 3 hours ago'],
    [HOUR, 'Synced 1 hour ago'],
    [2 * DAY, 'Synced 2 days ago'],
  ])('renders %ims as "%s"', (age, expected) => {
    expect(describeFreshness(NOW - age, NOW)).toBe(expected);
  });

  it('never shows a negative age from clock skew', () => {
    expect(describeFreshness(NOW + HOUR, NOW)).toBe('Synced just now');
  });
});

// Referenced so the mocked module is definitely loaded in this suite.
void AsyncStorage;
