// P6.5 — k6 load harness. Read-heavy + booking-heavy profiles, staged to a flash-sale spike.
// Requires k6 (https://k6.io) and a running staging API. NOT executed here (no staging stack) —
// this is the runnable reference; capacity is reported from a real run, never extrapolated locally.
//
//   BASE_URL=https://staging.eticketsgo.example PROFILE=read k6 run scripts/load/booking-load.js
//   BASE_URL=... PROFILE=booking SESSION_ID=<id> k6 run scripts/load/booking-load.js
import http from 'k6/http';
import { check, sleep } from 'k6';
import { Rate, Trend } from 'k6/metrics';

const BASE = __ENV.BASE_URL || 'http://localhost:4000/api';
const PROFILE = __ENV.PROFILE || 'read';
const SESSION_ID = __ENV.SESSION_ID || '';

const bookingSuccess = new Rate('booking_success');
const initLatency = new Trend('booking_init_latency', true);

// Staged traffic: warm-up → normal → ramp → flash-sale spike → sustained peak → recovery.
export const options = {
  scenarios: {
    main: {
      executor: 'ramping-vus',
      startVUs: 5,
      stages: [
        { duration: '1m', target: 20 }, // warm-up
        { duration: '3m', target: 50 }, // normal
        { duration: '2m', target: 150 }, // ramp
        { duration: '1m', target: 600 }, // flash-sale spike
        { duration: '3m', target: 600 }, // sustained peak
        { duration: '2m', target: 20 }, // recovery
      ],
    },
  },
  thresholds: {
    http_req_duration: ['p(95)<800', 'p(99)<2000'], // tune from baseline
    http_req_failed: ['rate<0.02'],
    booking_success: ['rate>0.95'],
  },
};

function readHeavy() {
  const paths = ['/events', '/events?category=movie', '/venues'];
  const p = paths[Math.floor(Math.random() * paths.length)];
  const r = http.get(`${BASE}${p}`);
  check(r, { 'read 2xx': (x) => x.status >= 200 && x.status < 300 });
  if (SESSION_ID) {
    const a = http.get(`${BASE}/sessions/${SESSION_ID}/availability`);
    check(a, { 'availability 2xx': (x) => x.status >= 200 && x.status < 300 });
  }
}

function bookingHeavy() {
  if (!SESSION_ID) return readHeavy();
  const t0 = Date.now();
  const init = http.post(
    `${BASE}/bookings/initiate`,
    JSON.stringify({ eventSessionId: SESSION_ID, quantity: 1 }),
    { headers: { 'Content-Type': 'application/json' } },
  );
  initLatency.add(Date.now() - t0);
  const ok = init.status >= 200 && init.status < 300;
  bookingSuccess.add(ok);
  check(init, { 'initiate ok/fail-closed': (x) => x.status < 500 }); // never a 5xx
  if (ok) {
    const id = (init.json() || {}).bookingId;
    if (id) http.get(`${BASE}/bookings/${id}/status`); // status poll
  }
}

export default function () {
  if (PROFILE === 'booking') bookingHeavy();
  else readHeavy();
  sleep(Math.random() * 1.5);
}
