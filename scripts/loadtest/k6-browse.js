/**
 * ETicketsGo — k6 browse/read load profile (CI / staging).
 *
 * Ramps virtual users through the public, anonymous browse surface:
 *   discovery → movie catalog → movie detail → show seat-layout → GA event detail.
 * These are the cached, read-heavy paths that dominate anonymous traffic.
 *
 * NOT executed in the local validation run (needs the k6 binary + a load target
 * that is NOT rate-limited the way the local single-node dev API is — see notes).
 *
 * Run against staging:
 *   k6 run -e BASE_URL=https://staging.eticketsgo.example/api \
 *          -e MOVIE_SLUG=skyfront-protocol \
 *          -e GA_SLUG=standup-night-with-zomato-comedy \
 *          scripts/loadtest/k6-browse.js
 *
 * Thresholds fail the run (non-zero exit) if p95 latency or error rate regress,
 * so this doubles as a CI performance gate.
 *
 * IMPORTANT: the API enforces a global throttle (120 req / 60 s per IP). For a
 * real load test, run k6 from multiple source IPs / a distributed pool, or raise
 * the throttle limit in the staging environment, otherwise VUs will be shed with
 * 429s rather than measuring true capacity.
 */
import http from 'k6/http';
import { check, sleep, group } from 'k6';
import { Rate, Trend } from 'k6/metrics';

const BASE_URL = __ENV.BASE_URL || 'http://127.0.0.1:4000/api';
const MOVIE_SLUG = __ENV.MOVIE_SLUG || 'skyfront-protocol';
const GA_SLUG = __ENV.GA_SLUG || 'standup-night-with-zomato-comedy';

const errorRate = new Rate('browse_errors');
const seatLayoutLatency = new Trend('seat_layout_ms', true);

export const options = {
  scenarios: {
    browse: {
      executor: 'ramping-vus',
      startVUs: 0,
      stages: [
        { duration: '30s', target: 20 }, // ramp up
        { duration: '1m', target: 50 }, // sustained browse load
        { duration: '1m', target: 100 }, // peak
        { duration: '30s', target: 0 }, // ramp down
      ],
      gracefulRampDown: '10s',
    },
  },
  thresholds: {
    http_req_duration: ['p(95)<400', 'p(99)<800'],
    http_req_failed: ['rate<0.01'],
    browse_errors: ['rate<0.01'],
    seat_layout_ms: ['p(95)<500'],
  },
};

function get(path, name) {
  const res = http.get(`${BASE_URL}${path}`, { tags: { name } });
  const ok = check(res, { [`${name} 200`]: (r) => r.status === 200 });
  errorRate.add(!ok);
  return res;
}

export default function () {
  group('discovery', () => {
    get('/public/discovery', 'discovery');
    sleep(0.5);
  });

  group('catalog', () => {
    get('/public/movies', 'movies_catalog');
    sleep(0.5);
  });

  let sessionId = null;
  group('movie_detail', () => {
    const res = get(`/public/movies/${MOVIE_SLUG}`, 'movie_detail');
    if (res.status === 200) {
      try {
        const body = res.json();
        const sessions = (body.shows || []).flatMap((s) => s.sessions || []);
        if (sessions.length) sessionId = sessions[0].id;
      } catch (_e) {
        /* ignore parse issues under load */
      }
    }
    sleep(0.5);
  });

  if (sessionId) {
    group('seat_layout', () => {
      const res = get(`/public/shows/${sessionId}/seats`, 'seat_layout');
      seatLayoutLatency.add(res.timings.duration);
      sleep(0.5);
    });
  }

  group('ga_event_detail', () => {
    get(`/public/events/${GA_SLUG}`, 'ga_event_detail');
    sleep(0.5);
  });
}
