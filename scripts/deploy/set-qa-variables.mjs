#!/usr/bin/env node
/**
 * Set the ETicketsGo QA application variables on Railway.
 *
 * Separate from provision-qa-railway.mjs because the two have different risk profiles:
 * provisioning creates infrastructure, this writes secrets. Keeping them apart means the
 * provisioning script can be re-run freely without touching credentials.
 *
 * Secret handling: the four QA signing secrets are generated here with crypto.randomBytes
 * and written straight to Railway. They are never printed, never logged, never written to
 * disk, and never returned by this script. If you need to see one, read it from the Railway
 * dashboard — that is deliberate.
 *
 * Idempotent, and specifically NON-DESTRUCTIVE about secrets: an existing value is left
 * alone. Re-running will not rotate a live secret and invalidate every issued JWT and
 * ticket QR. Pass --rotate-secrets to deliberately regenerate them.
 *
 * Usage:
 *   node scripts/deploy/set-qa-variables.mjs [--dry-run] [--rotate-secrets]
 */

import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';

const API = 'https://backboard.railway.app/graphql/v2';
const DRY = process.argv.includes('--dry-run');
const ROTATE = process.argv.includes('--rotate-secrets');
const TOKEN_FILE = process.env.RAILWAY_TOKEN_FILE ?? join(homedir(), '.railway-qa-token');

const TOKEN = readFileSync(TOKEN_FILE, 'utf8').trim();
if (!/^[0-9a-f-]{36}$/i.test(TOKEN)) {
  console.error(`${TOKEN_FILE} does not contain a bare 36-character token.`);
  process.exit(1);
}

async function gql(query, variables = {}) {
  const res = await fetch(API, {
    method: 'POST',
    headers: { 'Project-Access-Token': TOKEN, 'Content-Type': 'application/json' },
    body: JSON.stringify({ query, variables }),
  });
  const body = await res.json();
  if (body.errors) throw new Error(body.errors.map((e) => e.message).join('; '));
  return body.data;
}

/** 48 bytes base64url — comfortably past the 24-char minimum the API enforces in prod-like envs. */
const secret = () => randomBytes(48).toString('base64url');

// Public QA hostnames. Railway-generated for now; swap for the custom domains once
// Cloudflare is wired (NEXT_PUBLIC_API_URL requires a REBUILD, not a restart, because
// Next.js inlines it into the bundle at build time).
const API_HOST = process.env.QA_API_HOST ?? 'api-qa-f23c.up.railway.app';
const WEB_HOST = process.env.QA_WEB_HOST ?? 'customer-web-qa.up.railway.app';
const ORG_HOST = process.env.QA_ORG_HOST ?? 'organizer-web-qa.up.railway.app';
const ADMIN_HOST = process.env.QA_ADMIN_HOST ?? 'admin-web-qa.up.railway.app';

const API_URL = `https://${API_HOST}/api`;
const CORS = [`https://${WEB_HOST}`, `https://${ORG_HOST}`, `https://${ADMIN_HOST}`].join(',');

/** Variables that are secret: generated once, never rotated implicitly, never printed. */
const SECRETS = [
  'JWT_ACCESS_SECRET',
  'JWT_REFRESH_SECRET',
  'QR_SIGNING_SECRET',
  'PAYMENT_WEBHOOK_SECRET',
];

/**
 * Backend configuration, applied to both `api` and `worker` so the two agree on APP_ENV
 * (which drives every Redis namespace) and on the signing secrets (the worker verifies
 * what the API issued).
 *
 * The datastore URLs are Railway variable REFERENCES, not pasted strings — they resolve at
 * deploy time and follow credential rotation, and they cannot silently point at another
 * environment the way a copied URL can.
 */
const BACKEND = {
  APP_ENV: 'QA',
  NODE_ENV: 'production',
  DATABASE_URL: '${{Postgres.DATABASE_URL}}',
  REDIS_URL: '${{Redis.REDIS_URL}}',
  API_GLOBAL_PREFIX: 'api',
  TRUST_PROXY_HOPS: '1',
  CORS_ORIGINS: CORS,
  // QA posture: the simulated gateway, so bookings are deterministic and no money moves.
  // The API refuses to boot on a live key in QA unless PAYMENT_ALLOW_LIVE_KEYS_LOWER_ENV
  // is deliberately set, so this stays false as the second lock.
  PAYMENT_PROVIDER_NAME: 'mock',
  PAYMENT_LIVE_ENABLED: 'false',
  PAYMENT_ALLOW_LIVE_KEYS_LOWER_ENV: 'false',
  // Notification transports write to stdout rather than sending. QA must not be able to
  // email or push a real customer.
  EMAIL_PROVIDER: 'log',
  PUSH_PROVIDER: 'log',
  SMS_PROVIDER: 'log',
  WHATSAPP_PROVIDER: 'log',
  WEBPUSH_PROVIDER: 'log',
  STORAGE_DRIVER: 'local',
  // P6 money-off posture. Production refuses to boot with any of these on; QA matches it
  // so QA is actually testing the shipped configuration.
  BOOKING_ORCHESTRATOR_MODE: 'shadow',
  BOOKING_REFUND_POLICY_MODE: 'MANUAL_ONLY',
  BOOKING_COMPENSATION_AUTO_REFUND_ENABLED: 'false',
  BOOKING_COMPENSATION_AUTO_VOID_ENABLED: 'false',
  BOOKING_COMPENSATION_EXECUTION_ENABLED: 'false',
  INVENTORY_LOCKS_ENABLED: 'false',
  DOMAIN_EVENTS_ENABLED: 'false',
  DOMAIN_EVENT_DELIVERY_MODE: 'in_process',
  SENTRY_ENVIRONMENT: 'qa',
  SLOW_QUERY_MS: '500',
  // QA only — publishes the API surface. Must stay unset in UAT and production.
  ENABLE_SWAGGER: 'true',
};

/**
 * Build-time for the web tier: Next.js inlines these, so changing one needs a REBUILD.
 *
 * Every NEXT_PUBLIC_* the apps read must be listed here. Any that is missing silently falls
 * back to its hardcoded default, and those defaults are written for local development:
 *   - NEXT_PUBLIC_ORGANIZER_URL falls back to http://localhost:3001, so the deployed
 *     "Open organizer console" button pointed at the developer's own machine.
 *   - NEXT_PUBLIC_SITE_URL falls back to https://eticketsgo.com, so QA's robots.txt,
 *     sitemap.xml and canonical metadata advertised PRODUCTION URLs.
 * Neither fails a build or a health check — they just quietly do the wrong thing, which is
 * why they are enumerated per app rather than left to defaults.
 */
const WEB_COMMON = { NEXT_PUBLIC_API_URL: API_URL };
const WEB_BY_APP = {
  'customer-web': {
    ...WEB_COMMON,
    NEXT_PUBLIC_ORGANIZER_URL: `https://${ORG_HOST}`,
    NEXT_PUBLIC_SITE_URL: `https://${WEB_HOST}`,
  },
  'organizer-web': { ...WEB_COMMON },
  'admin-web': { ...WEB_COMMON },
};

async function main() {
  const { projectToken } = await gql('{ projectToken { projectId environmentId } }');
  const { projectId, environmentId } = projectToken;
  const { project } = await gql(
    `query($id:String!){ project(id:$id){ name services{edges{node{id name}}} } }`,
    { id: projectId },
  );
  const svc = new Map(project.services.edges.map((e) => [e.node.name, e.node.id]));

  console.log(`\nProject "${project.name}" — QA variables${DRY ? '   [DRY RUN]' : ''}`);
  console.log(`  api URL : ${API_URL}`);
  console.log(`  CORS    : ${CORS}\n`);

  const targets = [
    ['api', { ...BACKEND }],
    ['worker', { ...BACKEND }],
    ['customer-web', { ...WEB_BY_APP['customer-web'] }],
    ['organizer-web', { ...WEB_BY_APP['organizer-web'] }],
    ['admin-web', { ...WEB_BY_APP['admin-web'] }],
  ];

  for (const [name, vars] of targets) {
    const id = svc.get(name);
    if (!id) {
      console.log(`  SKIP ${name} — service not found`);
      continue;
    }

    // unrendered:true returns what is STORED, not what the container sees. Without it a
    // reference like ${{Postgres.DATABASE_URL}} reads back as the resolved connection
    // string, never matches, and gets rewritten on every run — harmless but it makes the
    // "unchanged" count meaningless, which is the only signal that a re-run was safe.
    const existing = await gql(
      `query($e:String!,$s:String!,$p:String!){ variables(environmentId:$e, serviceId:$s, projectId:$p, unrendered:true) }`,
      { e: environmentId, s: id, p: projectId },
    );

    // Secrets only for the backend services, and only when absent (or explicitly rotating).
    const isBackend = name === 'api' || name === 'worker';
    if (isBackend) {
      for (const key of SECRETS) {
        if (existing.variables[key] && !ROTATE) continue;
        vars[key] = null; // filled below from the shared set
      }
    }

    let wrote = 0;
    let kept = 0;
    for (const [k, v] of Object.entries(vars)) {
      const value = v === null ? sharedSecret(k) : v;
      if (existing.variables[k] === value) {
        kept += 1;
        continue;
      }
      if (!DRY) {
        await gql(`mutation($in:VariableUpsertInput!){ variableUpsert(input:$in) }`, {
          in: { projectId, environmentId, serviceId: id, name: k, value },
        });
      }
      wrote += 1;
    }
    console.log(
      `  ${name.padEnd(15)} ${DRY ? 'would write' : 'wrote'} ${String(wrote).padStart(2)}   unchanged ${kept}`,
    );
  }

  console.log(
    `\nSecrets are generated in-process and written straight to Railway — not printed here.\n` +
      `Read them from the Railway dashboard if ever needed.\n`,
  );
}

/**
 * One value per secret name for the whole run, so `api` and `worker` receive the SAME
 * secret. If they diverged, the worker could not verify a token the API signed.
 */
const _shared = new Map();
function sharedSecret(name) {
  if (!_shared.has(name)) _shared.set(name, secret());
  return _shared.get(name);
}

main().catch((e) => {
  console.error(`\nfailed: ${e.message}\n`);
  process.exit(1);
});
