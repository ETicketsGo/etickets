import AsyncStorage from '@react-native-async-storage/async-storage';
import { z } from 'zod';
import { ticketSchema, type Ticket } from '@/features/bookings/schema';

/**
 * On-device cache of issued tickets, so someone at a venue with no signal can still
 * show their ticket.
 *
 * ── WHAT IS STORED, AND WHAT DELIBERATELY IS NOT ──────────────────────────────────
 * `qrToken` is STRIPPED before writing. It is the signed credential the scanner
 * verifies, and it is the one field in the response with real value to an attacker;
 * the app only ever needs `qrDataUrl` to put a picture on the screen, so the token has
 * no business surviving on disk. Everything cached here is information the holder
 * already displays openly at the door.
 *
 * ── WHERE IT IS STORED ─────────────────────────────────────────────────────────────
 * AsyncStorage, not SecureStore. SecureStore is backed by the keychain/keystore, which
 * is sized for secrets — Android warns past ~2KB per value and a single base64 PNG QR
 * is larger than that, so a wallet of tickets does not fit and would fail at exactly
 * the wrong moment. The protection this data actually gets is the OS app sandbox plus
 * full-disk encryption on a locked device; a rooted or jailbroken device can read it.
 * That is an acceptable trade for a picture of a QR code and is stated plainly in
 * docs/OFFLINE-BEHAVIOR.md rather than dressed up.
 *
 * ── CROSS-ACCOUNT LEAKAGE ─────────────────────────────────────────────────────────
 * The cache key is namespaced by user id, and a read for user B can never return user
 * A's entry. Logout wipes every namespace, not just the current one, so a shared device
 * does not hand the next person a previous user's tickets.
 */

const KEY_PREFIX = 'etg.tickets.v1.';
const key = (userId: string) => `${KEY_PREFIX}${userId}`;

/** Ticket as cached: the API shape minus the credential. */
export const cachedTicketSchema = ticketSchema.omit({ qrToken: true });
export type CachedTicket = z.infer<typeof cachedTicketSchema>;

const cacheEnvelopeSchema = z.object({
  /** Schema version, so a future shape change discards rather than misreads. */
  version: z.literal(1),
  userId: z.string(),
  /** Epoch ms of the successful authenticated fetch these came from. */
  syncedAt: z.number(),
  tickets: z.array(cachedTicketSchema),
});

export type TicketCacheEnvelope = z.infer<typeof cacheEnvelopeSchema>;

/**
 * How stale a cache may be and still be shown.
 *
 * Seven days covers "loaded it at home, arriving at the venue" and any realistic
 * travel, while still expiring a wallet left on an old device. Tickets are not
 * refreshed by the server on a shorter cycle — `qrToken` is a stored column, not a
 * rotating code — so this is about the surrounding data (status, seat, attendee name)
 * going out of date, not about the QR itself decaying.
 */
export const MAX_CACHE_AGE_MS = 7 * 24 * 60 * 60 * 1000;

function stripCredential(ticket: Ticket): CachedTicket {
  // Destructured out rather than deleted, so a future field is not silently retained.
  const { qrToken: _qrToken, ...rest } = ticket;
  return rest;
}

/**
 * Persist tickets fetched while authenticated.
 *
 * Only upcoming tickets are kept: a past event's ticket is dead weight that widens the
 * amount of personal data sitting on the device for no benefit.
 */
export async function saveTickets(
  userId: string,
  tickets: Ticket[],
  now: number = Date.now(),
): Promise<void> {
  if (!userId) return;
  const upcoming = tickets.filter((t) => {
    const startsAt = new Date(t.startsAt).getTime();
    return Number.isFinite(startsAt) && startsAt >= now;
  });

  const envelope: TicketCacheEnvelope = {
    version: 1,
    userId,
    syncedAt: now,
    tickets: upcoming.map(stripCredential),
  };

  try {
    await AsyncStorage.setItem(key(userId), JSON.stringify(envelope));
  } catch {
    // A full disk must not break the online path that just succeeded.
  }
}

export type CacheReadResult =
  | { status: 'empty' }
  | { status: 'corrupt' }
  | { status: 'stale'; syncedAt: number; tickets: CachedTicket[] }
  | { status: 'ok'; syncedAt: number; tickets: CachedTicket[] };

/**
 * Read this user's cached tickets.
 *
 * Returns a discriminated result rather than throwing or returning null, because the
 * screen says something different for each case: nothing saved, saved but too old to
 * trust, or unreadable. Collapsing them all to "no tickets" is how a user at a gate is
 * told they have none when they have several.
 */
export async function readTickets(
  userId: string,
  now: number = Date.now(),
): Promise<CacheReadResult> {
  if (!userId) return { status: 'empty' };

  let raw: string | null;
  try {
    raw = await AsyncStorage.getItem(key(userId));
  } catch {
    return { status: 'corrupt' };
  }
  if (!raw) return { status: 'empty' };

  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(raw);
  } catch {
    // Truncated write, or a value from a different app version. Drop it rather than
    // leaving a permanently unreadable entry behind.
    await clearTickets(userId);
    return { status: 'corrupt' };
  }

  const parsed = cacheEnvelopeSchema.safeParse(parsedJson);
  if (!parsed.success) {
    await clearTickets(userId);
    return { status: 'corrupt' };
  }

  // Belt and braces against a mismatched key: never hand back another user's tickets.
  if (parsed.data.userId !== userId) {
    return { status: 'corrupt' };
  }

  // Drop entries whose event has since passed, even though save() filtered them —
  // the cache may have been written days ago.
  const tickets = parsed.data.tickets.filter((t) => {
    const startsAt = new Date(t.startsAt).getTime();
    return Number.isFinite(startsAt) && startsAt >= now;
  });

  const age = now - parsed.data.syncedAt;
  const stale = age > MAX_CACHE_AGE_MS;
  return {
    status: stale ? 'stale' : 'ok',
    syncedAt: parsed.data.syncedAt,
    tickets,
  };
}

/** Remove one user's cache. */
export async function clearTickets(userId: string): Promise<void> {
  try {
    await AsyncStorage.removeItem(key(userId));
  } catch {
    // Nothing useful to do; the next read validates anyway.
  }
}

/**
 * Remove EVERY user's cache. Called on logout.
 *
 * All namespaces, not just the one signing out: a device that has held two accounts
 * should not keep the other one's tickets once someone deliberately signs out.
 */
export async function clearAllTickets(): Promise<void> {
  try {
    const keys = await AsyncStorage.getAllKeys();
    const ours = keys.filter((k) => k.startsWith(KEY_PREFIX));
    if (ours.length > 0) await AsyncStorage.multiRemove(ours);
  } catch {
    // Ignore.
  }
}

/** "Synced 3 hours ago" — the label shown above offline tickets. */
export function describeFreshness(syncedAt: number, now: number = Date.now()): string {
  const minutes = Math.max(0, Math.floor((now - syncedAt) / 60000));
  if (minutes < 1) return 'Synced just now';
  if (minutes < 60) return `Synced ${minutes} minute${minutes === 1 ? '' : 's'} ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `Synced ${hours} hour${hours === 1 ? '' : 's'} ago`;
  const days = Math.floor(hours / 24);
  return `Synced ${days} day${days === 1 ? '' : 's'} ago`;
}
