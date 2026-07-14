/**
 * ETicketsGo — k6 booking/write load profile (CI / staging).
 *
 * Each VU performs the full purchase funnel against the throughput-critical
 * seat-hold path:
 *   login → read seat layout → pick an AVAILABLE seat → POST /bookings (atomic
 *   hold) → mock-pay (confirm) so inventory settles held→sold.
 *
 * This exercises the DB-arbitrated atomic hold under sustained write concurrency.
 * Because many VUs contend for a finite pool of seats, a share of booking attempts
 * are EXPECTED to lose the race and return 409 BOOKING_INVENTORY_UNAVAILABLE — that
 * is correct behaviour (no oversell), so 409 is counted as a valid outcome, not an
 * error. Only 5xx / unexpected statuses count as errors.
 *
 * NOT executed in the local validation run (needs the k6 binary + a load target
 * with enough seeded seat inventory and a relaxed throttle — see notes).
 *
 * Run against staging:
 *   k6 run -e BASE_URL=https://staging.eticketsgo.example/api \
 *          -e MOVIE_SLUG=skyfront-protocol \
 *          -e EMAIL=customer1@eticketsgo.test -e PASSWORD='Password123!' \
 *          scripts/loadtest/k6-booking.js
 *
 * IMPORTANT: seed enough seats/shows for the target VU count, and run from a
 * distributed pool (or raise the 120 req/60s throttle on staging) so the test
 * measures hold throughput rather than throttling. Confirmed bookings consume
 * real inventory — use a disposable/staging dataset.
 */
import http from 'k6/http';
import { check, sleep, group } from 'k6';
import { Rate, Counter, Trend } from 'k6/metrics';

const BASE_URL = __ENV.BASE_URL || 'http://127.0.0.1:4000/api';
const MOVIE_SLUG = __ENV.MOVIE_SLUG || 'skyfront-protocol';
const EMAIL = __ENV.EMAIL || 'customer1@eticketsgo.test';
const PASSWORD = __ENV.PASSWORD || 'Password123!';

const serverErrors = new Rate('booking_server_errors');
const booked = new Counter('bookings_won');
const seatConflicts = new Counter('seat_conflicts_409');
const paid = new Counter('bookings_paid');
const holdLatency = new Trend('booking_hold_ms', true);

export const options = {
  scenarios: {
    booking: {
      executor: 'ramping-vus',
      startVUs: 0,
      stages: [
        { duration: '30s', target: 10 },
        { duration: '1m', target: 30 },
        { duration: '1m', target: 60 }, // hot on-sale burst
        { duration: '30s', target: 0 },
      ],
      gracefulRampDown: '10s',
    },
  },
  thresholds: {
    // Only 5xx / unexpected outcomes are failures; 409 seat-conflicts are valid.
    booking_server_errors: ['rate<0.005'],
    booking_hold_ms: ['p(95)<1500'],
  },
};

function login() {
  const res = http.post(
    `${BASE_URL}/auth/login`,
    JSON.stringify({ email: EMAIL, password: PASSWORD }),
    { headers: { 'Content-Type': 'application/json' }, tags: { name: 'login' } },
  );
  check(res, { 'login 201': (r) => r.status === 201 });
  try {
    return res.json('accessToken');
  } catch (_e) {
    return null;
  }
}

export default function () {
  const token = login();
  if (!token) {
    serverErrors.add(true);
    return;
  }
  const authHeaders = {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${token}`,
  };

  // Resolve a session + an available seat.
  let sessionId = null;
  const movie = http.get(`${BASE_URL}/public/movies/${MOVIE_SLUG}`, {
    tags: { name: 'movie_detail' },
  });
  try {
    const sessions = (movie.json('shows') || []).flatMap((s) => s.sessions || []);
    if (sessions.length) sessionId = sessions[sessions.length - 1].id; // furthest-out show
  } catch (_e) {
    /* ignore */
  }
  if (!sessionId) {
    serverErrors.add(movie.status >= 500);
    return;
  }

  let seat = null;
  let ticketTypeId = null;
  group('seat_layout', () => {
    const res = http.get(`${BASE_URL}/public/shows/${sessionId}/seats`, {
      tags: { name: 'seat_layout' },
    });
    check(res, { 'seat layout 200': (r) => r.status === 200 });
    serverErrors.add(res.status >= 500);
    try {
      const body = res.json();
      const catMap = new Map(body.categories.map((c) => [c.id, c.ticketTypeId]));
      const seats = body.sections
        .flatMap((s) => s.rows)
        .flatMap((r) => r.seats)
        .filter((s) => s.status === 'AVAILABLE' && catMap.get(s.categoryId));
      if (seats.length) {
        // Randomize to spread contention across the seat pool.
        seat = seats[Math.floor(Math.random() * seats.length)];
        ticketTypeId = catMap.get(seat.categoryId);
      }
    } catch (_e) {
      /* ignore */
    }
    sleep(0.3);
  });
  if (!seat) return;

  // Atomic hold.
  let bookingId = null;
  group('book', () => {
    const res = http.post(
      `${BASE_URL}/bookings`,
      JSON.stringify({
        eventSessionId: sessionId,
        items: [{ ticketTypeId, quantity: 1, seatIds: [seat.id] }],
        buyerName: 'k6 Load',
        buyerEmail: EMAIL,
      }),
      { headers: authHeaders, tags: { name: 'book' } },
    );
    holdLatency.add(res.timings.duration);
    // 201 = won the seat; 409 = lost the race (valid, no oversell); 5xx = failure.
    const valid = res.status === 201 || res.status === 409;
    check(res, { 'booking 201 or 409': () => valid });
    serverErrors.add(res.status >= 500);
    if (res.status === 201) {
      booked.add(1);
      try {
        bookingId = res.json('id');
      } catch (_e) {
        /* ignore */
      }
    } else if (res.status === 409) {
      seatConflicts.add(1);
    }
    sleep(0.3);
  });

  // Settle held→sold (only if we won a seat). Two steps mirror the real funnel:
  //   1) POST /bookings/:id/pay      → create a payment intent (owner-authed)
  //   2) POST /payments/:id/mock-pay → simulate the provider succeeding (public)
  if (bookingId) {
    group('pay', () => {
      const intent = http.post(`${BASE_URL}/bookings/${bookingId}/pay`, null, {
        headers: authHeaders,
        tags: { name: 'pay_intent' },
      });
      serverErrors.add(intent.status >= 500);

      const settle = http.post(
        `${BASE_URL}/payments/${bookingId}/mock-pay`,
        JSON.stringify({ outcome: 'succeeded' }),
        { headers: { 'Content-Type': 'application/json' }, tags: { name: 'mock_pay' } },
      );
      serverErrors.add(settle.status >= 500);
      if (settle.status >= 200 && settle.status < 300) paid.add(1);
      sleep(0.3);
    });
  }
}
