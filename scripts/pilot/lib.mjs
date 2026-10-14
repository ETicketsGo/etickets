/**
 * Shared helpers for the pilot certification scripts.
 *
 * ── AN ALLOWLIST, LIKE scripts/qa-demo/qa-guard.mjs ────────────────────────────────
 * These scripts register accounts, create events, take (test-mode) payments and raise refunds.
 * That is exactly right on QA and UAT and exactly wrong anywhere a real customer could see it,
 * so the question asked is "is this host NAMED as a test environment?" - never "does it look
 * like production?". Anything not named (production, a preview deploy, localhost, a typo) is
 * refused before the first request.
 */
import fs from 'node:fs';
import path from 'node:path';

export const ENVIRONMENTS = {
  qa: {
    name: 'QA',
    api: 'https://api-qa-f580.up.railway.app/api',
    apiHosts: ['api-qa-f580.up.railway.app', 'api-qa.eticketsgo.com'],
    customer: 'https://qa.eticketsgo.com',
    organizer: 'https://organizer-qa.eticketsgo.com',
    admin: 'https://admin-qa.eticketsgo.com',
  },
  uat: {
    name: 'UAT',
    api: 'https://api-uat-7530.up.railway.app/api',
    apiHosts: ['api-uat-7530.up.railway.app'],
    customer: 'https://customer-web-uat.up.railway.app',
    organizer: 'https://organizer-web-uat.up.railway.app',
    admin: 'https://admin-web-uat-7af7.up.railway.app',
  },
};

/** @returns {{ allowed: boolean, reason: string }} decided from the URL alone. */
export function targetVerdict(envKey, apiBase) {
  const env = ENVIRONMENTS[envKey];
  if (!env) return { allowed: false, reason: `Unknown environment "${envKey}" (use qa or uat).` };
  let url;
  try {
    url = new URL(apiBase);
  } catch {
    return { allowed: false, reason: `"${apiBase}" is not a URL.` };
  }
  if (url.protocol !== 'https:' || url.username || url.password || url.port) {
    return { allowed: false, reason: 'Only plain https URLs on a named test host are allowed.' };
  }
  if (!env.apiHosts.includes(url.hostname.toLowerCase())) {
    return {
      allowed: false,
      reason: `Refusing ${url.hostname}: ${env.name} certification only writes to ${env.apiHosts.join(', ')}.`,
    };
  }
  return { allowed: true, reason: 'ok' };
}

export function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/** One recorder per run: every step is PASS, FAIL or BLOCKED, with its evidence. */
export function createRecorder(file) {
  const rows = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : [];
  const save = () => fs.writeFileSync(file, JSON.stringify(rows, null, 2));
  return {
    rows,
    record(gate, id, step, status, note = '', evidence = {}) {
      const i = rows.findIndex((r) => r.id === id);
      const row = { gate, id, step, status, note, evidence, at: new Date().toISOString() };
      if (i >= 0) rows[i] = row;
      else rows.push(row);
      save();
      console.log(`${status.padEnd(7)} ${id}  ${step}${note ? '  - ' + note : ''}`);
      return status === 'PASS';
    },
  };
}

export function loadState(file) {
  return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : {};
}
export function saveState(file, state) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(state, null, 2));
}

/**
 * A small API client. Railway's gateway intermittently answers a plain-text "Internal Server
 * Error"; `res.json()` on that throws a misleading parse error, so the body is read as text
 * first and a 5xx with a non-JSON body is retried a few times.
 */
export function createApi(base) {
  // A full run waits minutes for holds and the reconciliation sweep, longer than an access token
  // lives. Each token this helper issued remembers who it belongs to; on a 401 the user signs in
  // again once, and every later call made with the old token uses the new one.
  const owners = new Map(); // token -> { email, password }
  const replaced = new Map(); // old token -> newer token
  const latest = (t) => {
    while (t && replaced.has(t)) t = replaced.get(t);
    return t;
  };
  async function call(method, p, opts = {}) {
    const token = latest(opts.token);
    const r = await send(method, p, { ...opts, token });
    if (r.status !== 401 || !token || !owners.has(token) || p.startsWith('/auth/')) return r;
    const again = await login(owners.get(token).email, owners.get(token).password);
    if (!again.token) return r;
    replaced.set(token, again.token);
    return send(method, p, { ...opts, token: again.token });
  }
  async function send(method, p, { token, body, headers = {}, retries = 3 } = {}) {
    for (let attempt = 0; ; attempt++) {
      const res = await fetch(`${base}${p}`, {
        method,
        headers: {
          ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
          ...(token ? { authorization: `Bearer ${token}` } : {}),
          ...headers,
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      const text = await res.text();
      let json = null;
      try {
        json = text ? JSON.parse(text) : null;
      } catch {
        json = null;
      }
      if (res.status >= 502 && json === null && attempt < retries) {
        await sleep(2000 * (attempt + 1));
        continue;
      }
      return { status: res.status, body: json, text };
    }
  }
  const login = async (email, password) => {
    const r = await send('POST', '/auth/login', { body: { email, password } });
    const token = r.body?.accessToken ?? r.body?.tokens?.accessToken;
    if (token) owners.set(token, { email, password });
    return { ...r, token, userId: r.body?.user?.id };
  };
  return { call, login };
}

/** The first line of an error body, for evidence. Never a token. */
export const errCode = (r) =>
  `${r.status} ${r.body?.code ?? r.body?.error ?? ''} ${String(r.body?.message ?? '').slice(0, 140)}`.trim();
