'use client';

import { api, type BookingRequest, type GuestBookingResult } from '@/lib/api';

/**
 * What this browser holds on behalf of a guest.
 *
 * ── WHY THERE IS A TOKEN AT ALL ────────────────────────────────────────────────────
 * A guest has no account, so nothing about them is stored server side that they could sign
 * in to. The anonymous session token is how the server recognises the browser that created a
 * booking: it is sent as `x-anon-session` and it is the only thing standing between a guest
 * and their own booking. Lose it and the booking is still theirs -- it is just no longer
 * reachable from this tab, and the way back is the link emailed to them.
 *
 * ── WHY EVERY READ AND WRITE IS WRAPPED ────────────────────────────────────────────
 * `localStorage` throws, not returns, when a browser refuses it: a private window with site
 * data blocked, an iframe under a strict policy, a device with the quota full. An unguarded
 * read is therefore an exception thrown in the middle of checkout, and the buyer sees a blank
 * page instead of a payment button. Every access here is in a try/catch and every failure
 * degrades to "we have no token", which is a state the flow already handles.
 *
 * ── WHY TWO KEYS ───────────────────────────────────────────────────────────────────
 * `etg_guest_bookings` maps a booking id to the token that can read it, so two bookings made
 * in the same browser cannot be confused for each other. `etg_anon_session` is the most
 * recent token on its own, sent when creating the NEXT booking so the server can keep one
 * anonymous session rather than issuing a fresh one per purchase.
 */
const BOOKINGS_KEY = 'etg_guest_bookings';
const ANON_KEY = 'etg_anon_session';

type BookingTokens = Record<string, string>;

function readBookings(): BookingTokens {
  try {
    const raw = localStorage.getItem(BOOKINGS_KEY);
    if (!raw) return {};
    const parsed: unknown = JSON.parse(raw);
    // A hand-edited or half-written value must not become a token. Only strings survive.
    if (!parsed || typeof parsed !== 'object') return {};
    const out: BookingTokens = {};
    for (const [id, token] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof token === 'string' && token) out[id] = token;
    }
    return out;
  } catch {
    return {};
  }
}

function writeBookings(next: BookingTokens): void {
  try {
    localStorage.setItem(BOOKINGS_KEY, JSON.stringify(next));
  } catch {
    /* A browser that will not store it still lets the buyer pay in this tab. */
  }
}

/** The most recent anonymous session this browser was given, if any. */
export function anonSessionToken(): string | null {
  try {
    return localStorage.getItem(ANON_KEY) || null;
  } catch {
    return null;
  }
}

/** The token that can read this booking, or null when this browser is not holding it. */
export function guestTokenFor(bookingId: string): string | null {
  return readBookings()[bookingId] ?? null;
}

/** True when this browser bought this booking as a guest. */
export function isGuestBooking(bookingId: string): boolean {
  return guestTokenFor(bookingId) !== null;
}

/** Remember that `bookingId` can be read with `token`. */
export function rememberGuestBooking(bookingId: string, token: string): void {
  if (!token) return;
  writeBookings({ ...readBookings(), [bookingId]: token });
  try {
    localStorage.setItem(ANON_KEY, token);
  } catch {
    /* ignore */
  }
}

/** Forget a booking this browser can no longer do anything with (cancelled, or expired). */
export function forgetGuestBooking(bookingId: string): void {
  const all = readBookings();
  if (!(bookingId in all)) return;
  delete all[bookingId];
  writeBookings(all);
}

/**
 * A fresh session token, made here.
 *
 * ── WHY THE BROWSER MINTS THIS AND DOES NOT WAIT TO BE GIVEN ONE ───────────────────
 * The server issues a token only when the booking orchestrator runs in ACTIVE mode, and every
 * environment -- local, QA, UAT and production -- runs it in shadow. So on a first purchase
 * the response carries no token, and a client that waits for one stores nothing: the buyer
 * pays and is then told the booking is not open in this browser, which is exactly what
 * happened the first time this flow was run end to end.
 *
 * Sending our own is not a way around the check. In shadow mode the server accepts any
 * well-formed token because there is no workflow row to bind it to -- the unguessable booking
 * id is what protects the booking there, as it already does for guest payment. In active mode
 * the server ADOPTS the token it is sent and stores its hash as the owner, so the same value
 * keeps working and the browser holds one session across bookings either way.
 *
 * 256 bits from the platform's own cryptographic generator, which is the same size the server
 * uses. `crypto.randomUUID` would be 122 bits of it and the wrong shape.
 */
function newAnonToken(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  // base64url: what the server's own issuer produces, so both sides read the same alphabet.
  const base64 = btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  return `anon_${base64}`;
}

/**
 * Hold tickets as a guest, and keep hold of the way back to them.
 *
 * One function so that "create the booking" and "remember how to reach it" cannot come apart.
 * They did come apart in an earlier draft of this flow, and the result was a paid booking that
 * the tab which made it could not open.
 *
 * The token kept is the one the server returned when it returned one, and otherwise the one we
 * sent -- which the server accepted, so it still reads the booking.
 */
export async function startGuestBooking(body: BookingRequest): Promise<GuestBookingResult> {
  const sent = anonSessionToken() ?? newAnonToken();
  const booking = await api.createGuestBooking(body, sent);
  rememberGuestBooking(booking.id, booking.anonymousSessionToken ?? sent);
  return booking;
}
