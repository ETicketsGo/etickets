#!/usr/bin/env node
/**
 * Deployment-configuration gate for the Railway setup.
 *
 * Everything here is verifiable OFFLINE, without Railway credentials — that is the point.
 * The failure modes it catches (a start command that cannot resolve inside the image, a
 * migration racing across replicas, a live key committed to a template) are ones that
 * otherwise surface as a broken production deploy at the worst possible moment.
 *
 * Checks, per Railway service config under deploy/railway/ plus the root railway.json:
 *   - the referenced Dockerfile exists
 *   - the start command resolves against that Dockerfile's WORKDIR
 *   - a health-check path is declared and matches a route the service actually serves
 *   - exactly ONE service runs migrations, and via preDeployCommand (never startCommand)
 *   - no destructive Prisma command anywhere (migrate reset / db push / migrate dev)
 *   - no port is hard-coded in a start command (Railway injects PORT)
 *
 * And, per environment template under deploy/railway/env/:
 *   - no real-looking credential is committed (live/test gateway keys, Railway tokens…)
 *   - APP_ENV matches the file, and its payment posture agrees with the app's boot guards
 *   - the required variable set is present
 *
 * Usage:  node scripts/deploy/validate-railway-config.mjs
 * Exit:   0 = all checks pass, 1 = at least one failure.
 */

import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const RAILWAY_DIR = join(ROOT, 'deploy/railway');
const ENV_DIR = join(RAILWAY_DIR, 'env');

const failures = [];
const warnings = [];
let checks = 0;

const fail = (where, message) => failures.push(`${where}: ${message}`);
const warn = (where, message) => warnings.push(`${where}: ${message}`);
const check = (ok, where, message) => {
  checks += 1;
  if (!ok) fail(where, message);
  return ok;
};

// ── Service configs ──────────────────────────────────────────────────────────

/**
 * Each Railway service, with the facts a reviewer would otherwise have to hold in their
 * head: where the image's WORKDIR lands, and which health path the service really serves.
 * `expectMigrations` encodes the single-executor rule.
 */
const SERVICES = [
  {
    file: 'api.railway.json',
    dockerfile: 'apps/api/Dockerfile',
    workdir: 'apps/api',
    start: 'node dist/main.js',
    health: '/api/health',
    expectMigrations: true,
  },
  {
    file: 'worker.railway.json',
    dockerfile: 'apps/worker/Dockerfile',
    workdir: 'apps/worker',
    start: 'node dist/main.js',
    health: '/health',
    expectMigrations: false,
  },
  {
    file: 'customer-web.railway.json',
    dockerfile: 'apps/customer-web/Dockerfile',
    workdir: '',
    start: 'node apps/customer-web/server.js',
    health: '/api/health',
    expectMigrations: false,
  },
  {
    file: 'organizer-web.railway.json',
    dockerfile: 'apps/organizer-web/Dockerfile',
    workdir: '',
    start: 'node apps/organizer-web/server.js',
    health: '/api/health',
    expectMigrations: false,
  },
  {
    file: 'admin-web.railway.json',
    dockerfile: 'apps/admin-web/Dockerfile',
    workdir: '',
    start: 'node apps/admin-web/server.js',
    health: '/api/health',
    expectMigrations: false,
  },
  // One-shot job, not a long-running service: it runs to completion and exits, so it has
  // no health endpoint and must never restart. `oneShot` relaxes the health-check rule and
  // adds a restart-policy rule the long-running services do not need.
  {
    file: 'db-seed.railway.json',
    dockerfile: 'apps/api/Dockerfile',
    workdir: 'apps/api',
    start: "npx ts-node --transpile-only --compiler-options '{\"module\":\"commonjs\",\"moduleResolution\":\"node\"}' prisma/seed.ts",
    health: undefined,
    expectMigrations: false,
    oneShot: true,
  },
];

/** Prisma commands that drop data or bypass the migration history. Never in a deploy path. */
const DESTRUCTIVE = [
  { pattern: /migrate\s+reset/, name: 'prisma migrate reset (drops the database)' },
  { pattern: /db\s+push/, name: 'prisma db push (bypasses migration history)' },
  { pattern: /migrate\s+dev/, name: 'prisma migrate dev (interactive; authors migrations)' },
];

function validateServiceConfig(svc) {
  const where = `deploy/railway/${svc.file}`;
  const path = join(RAILWAY_DIR, svc.file);
  if (!check(existsSync(path), where, 'config file is missing')) return;

  let cfg;
  try {
    cfg = JSON.parse(readFileSync(path, 'utf8'));
  } catch (err) {
    fail(where, `is not valid JSON — ${err.message}`);
    return;
  }

  const build = cfg.build ?? {};
  const deploy = cfg.deploy ?? {};

  check(build.builder === 'DOCKERFILE', where, `build.builder must be DOCKERFILE`);
  check(
    build.dockerfilePath === svc.dockerfile,
    where,
    `build.dockerfilePath should be ${svc.dockerfile} (got ${build.dockerfilePath})`,
  );
  check(
    existsSync(join(ROOT, build.dockerfilePath ?? '')),
    where,
    `referenced Dockerfile does not exist: ${build.dockerfilePath}`,
  );

  // The start command runs with the image's WORKDIR as cwd. A path that is correct
  // relative to the repo root but not to WORKDIR boots nothing and is easy to miss.
  check(
    deploy.startCommand === svc.start,
    where,
    `deploy.startCommand should be "${svc.start}" (resolved against the image WORKDIR /app/${svc.workdir}); got "${deploy.startCommand}"`,
  );

  if (svc.oneShot) {
    // A job that runs to completion serves nothing, so a health check would fail it.
    check(
      deploy.healthcheckPath === undefined,
      where,
      `a one-shot job must not declare a healthcheckPath (got ${deploy.healthcheckPath})`,
    );
    // NEVER is a correctness requirement here, not a preference: prisma/seed.ts calls
    // reset() and deletes existing data before writing, so any restart re-wipes the
    // environment. ON_FAILURE would turn one bad run into a repeated data loss.
    check(
      deploy.restartPolicyType === 'NEVER',
      where,
      `a one-shot seed job must set restartPolicyType NEVER — the seed deletes data before writing, so a restart wipes the environment (got ${deploy.restartPolicyType})`,
    );
  } else {
    check(
      deploy.healthcheckPath === svc.health,
      where,
      `deploy.healthcheckPath should be ${svc.health} (got ${deploy.healthcheckPath})`,
    );
    check(
      typeof deploy.healthcheckTimeout === 'number' && deploy.healthcheckTimeout >= 30,
      where,
      'deploy.healthcheckTimeout should be >= 30s so a cold start is not mistaken for a failure',
    );
    check(
      deploy.restartPolicyType === 'ON_FAILURE',
      where,
      'deploy.restartPolicyType should be ON_FAILURE',
    );
  }

  // Migration ownership: exactly one service, via preDeployCommand.
  const pre = deploy.preDeployCommand ?? '';
  const startsMigration = /prisma\s+migrate/.test(deploy.startCommand ?? '');
  check(
    !startsMigration,
    where,
    'migrations must not run from startCommand — every replica would race on every restart; use preDeployCommand',
  );
  if (svc.expectMigrations) {
    check(
      /prisma\s+migrate\s+deploy/.test(pre),
      where,
      'this service owns migrations and must run `prisma migrate deploy` as its preDeployCommand',
    );
  } else {
    check(
      !/prisma\s+migrate/.test(pre),
      where,
      'only the api service may run migrations (single executor); remove the migration from preDeployCommand',
    );
  }

  // Destructive commands, anywhere in the deploy config.
  const allCommands = `${pre} ${deploy.startCommand ?? ''}`;
  for (const d of DESTRUCTIVE) {
    check(!d.pattern.test(allCommands), where, `deploy command contains ${d.name}`);
  }

  // Railway injects PORT; a pinned port in the start command silently breaks routing.
  check(
    !/(-p|--port)[\s=]\d+/.test(deploy.startCommand ?? ''),
    where,
    'start command hard-codes a port — Railway injects PORT and the app must bind it',
  );

  check(
    typeof cfg['//'] === 'string' && cfg['//'].length > 0,
    where,
    'missing the "//" note explaining root-directory / migration / build-arg behaviour',
  );
}

// ── Environment templates ────────────────────────────────────────────────────

/**
 * Patterns for credentials that must never be committed. Placeholders in these templates
 * end in REPLACE_ME, so the check is "looks like a real value", not "mentions a key name".
 */
const SECRET_PATTERNS = [
  { re: /\bsk_live_(?!REPLACE_ME)[A-Za-z0-9]{8,}/, name: 'Stripe live secret key' },
  { re: /\bsk_test_(?!REPLACE_ME)[A-Za-z0-9]{8,}/, name: 'Stripe test secret key' },
  { re: /\brzp_live_(?!REPLACE_ME)[A-Za-z0-9]{8,}/, name: 'Razorpay live key id' },
  { re: /\brzp_test_(?!REPLACE_ME)[A-Za-z0-9]{8,}/, name: 'Razorpay test key id' },
  { re: /\bwhsec_(?!REPLACE_ME)[A-Za-z0-9]{16,}/, name: 'Stripe webhook signing secret' },
  { re: /\bSG\.[A-Za-z0-9_-]{20,}/, name: 'SendGrid API key' },
  { re: /\bAKIA[0-9A-Z]{16}\b/, name: 'AWS access key id' },
  { re: /-----BEGIN [A-Z ]*PRIVATE KEY-----/, name: 'private key block' },
];

/** Variables every environment must define for the API to boot at all. */
const REQUIRED_VARS = [
  'APP_ENV',
  'NODE_ENV',
  'DATABASE_URL',
  'REDIS_URL',
  'JWT_ACCESS_SECRET',
  'JWT_REFRESH_SECRET',
  'QR_SIGNING_SECRET',
  'PAYMENT_WEBHOOK_SECRET',
  'CORS_ORIGINS',
  'NEXT_PUBLIC_API_URL',
  'PAYMENT_PROVIDER_NAME',
];

const ENV_TEMPLATES = [
  { file: 'qa.env.example', appEnv: 'QA', allowDummyGateway: true },
  { file: 'uat.env.example', appEnv: 'UAT', allowDummyGateway: false },
  { file: 'production.env.example', appEnv: 'PRODUCTION', allowDummyGateway: false },
];

/** Parse `KEY=value` lines, ignoring comments. Returns a Map of uncommented assignments. */
function parseEnvTemplate(text) {
  const vars = new Map();
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq <= 0) continue;
    const key = trimmed.slice(0, eq).trim();
    // Strip a trailing `# comment` from the value.
    const value = trimmed
      .slice(eq + 1)
      .replace(/\s+#.*$/, '')
      .trim();
    if (/^[A-Z][A-Z0-9_]*$/.test(key)) vars.set(key, value);
  }
  return vars;
}

function validateEnvTemplate(tpl) {
  const where = `deploy/railway/env/${tpl.file}`;
  const path = join(ENV_DIR, tpl.file);
  if (!check(existsSync(path), where, 'template is missing')) return;

  const text = readFileSync(path, 'utf8');
  const vars = parseEnvTemplate(text);

  for (const p of SECRET_PATTERNS) {
    const hit = text.match(p.re);
    check(!hit, where, `contains what looks like a real ${p.name} ("${hit?.[0]}") — never commit credentials`);
  }

  check(
    vars.get('APP_ENV') === tpl.appEnv,
    where,
    `APP_ENV must be ${tpl.appEnv} (got ${vars.get('APP_ENV')}) — it drives payment-env resolution and every Redis namespace`,
  );

  for (const required of REQUIRED_VARS) {
    check(vars.has(required), where, `missing required variable ${required}`);
  }

  // Payment posture must agree with what the app enforces at boot.
  const provider = vars.get('PAYMENT_PROVIDER_NAME');
  if (!tpl.allowDummyGateway) {
    check(
      provider !== 'mock',
      where,
      `PAYMENT_PROVIDER_NAME=mock is not the ${tpl.appEnv} posture (production refuses it at boot)`,
    );
  }
  check(
    vars.get('PAYMENT_ALLOW_LIVE_KEYS_LOWER_ENV') === 'false',
    where,
    'PAYMENT_ALLOW_LIVE_KEYS_LOWER_ENV must default to false — it is the only way a live key can boot in a lower environment',
  );
  if (tpl.appEnv !== 'PRODUCTION') {
    check(
      vars.get('PAYMENT_LIVE_ENABLED') === 'false',
      where,
      'PAYMENT_LIVE_ENABLED must be false outside production',
    );
  }

  // Money automation stays off everywhere (production fails to boot otherwise).
  for (const flag of [
    'BOOKING_COMPENSATION_AUTO_REFUND_ENABLED',
    'BOOKING_COMPENSATION_AUTO_VOID_ENABLED',
    'BOOKING_COMPENSATION_EXECUTION_ENABLED',
  ]) {
    check(vars.get(flag) === 'false', where, `${flag} must be false (P6 money-off posture)`);
  }
  check(
    vars.get('BOOKING_REFUND_POLICY_MODE') === 'MANUAL_ONLY',
    where,
    'BOOKING_REFUND_POLICY_MODE must be MANUAL_ONLY',
  );

  // CORS must be real origins — the API refuses to boot on localhost/unset in prod-like envs.
  const cors = vars.get('CORS_ORIGINS') ?? '';
  check(!cors.includes('localhost'), where, 'CORS_ORIGINS must not contain localhost');
  check(!cors.includes('*'), where, 'CORS_ORIGINS must not use a wildcard');
  check(
    cors.split(',').every((o) => o.trim().startsWith('https://')),
    where,
    'every CORS origin must be https',
  );

  // Cross-environment hostname bleed: a QA template naming production hosts (or vice
  // versa) is how an environment ends up talking to the wrong API.
  const apiUrl = vars.get('NEXT_PUBLIC_API_URL') ?? '';
  const suffix = { QA: '-qa.', UAT: '-uat.', PRODUCTION: null }[tpl.appEnv];
  if (suffix) {
    check(
      apiUrl.includes(suffix),
      where,
      `NEXT_PUBLIC_API_URL (${apiUrl}) does not look like a ${tpl.appEnv} hostname (expected "${suffix}")`,
    );
  } else {
    check(
      !apiUrl.includes('-qa.') && !apiUrl.includes('-uat.'),
      where,
      `NEXT_PUBLIC_API_URL (${apiUrl}) points at a non-production hostname`,
    );
  }

  // Swagger publishes the whole API surface; production must not enable it.
  if (tpl.appEnv === 'PRODUCTION') {
    check(
      vars.get('ENABLE_SWAGGER') === undefined,
      where,
      'ENABLE_SWAGGER must stay unset in production',
    );
    check(
      vars.get('SENTRY_ENVIRONMENT') === 'production',
      where,
      'SENTRY_ENVIRONMENT must be production so the issue stream is separated',
    );
  }
}

// ── Cross-cutting checks ─────────────────────────────────────────────────────

function validateNoStrayConfigs() {
  const where = 'deploy/railway';
  if (!existsSync(RAILWAY_DIR)) {
    fail(where, 'directory is missing');
    return;
  }
  const known = new Set(SERVICES.map((s) => s.file));
  for (const entry of readdirSync(RAILWAY_DIR)) {
    if (entry.endsWith('.railway.json') && !known.has(entry)) {
      warn(where, `unrecognised service config ${entry} — add it to this validator or remove it`);
    }
  }
}

/** The root railway.json is the fallback for a service with no config path set. */
function validateRootConfig() {
  const where = 'railway.json';
  const path = join(ROOT, 'railway.json');
  if (!check(existsSync(path), where, 'root fallback config is missing')) return;
  const cfg = JSON.parse(readFileSync(path, 'utf8'));
  const deploy = cfg.deploy ?? {};
  check(
    !/prisma\s+migrate/.test(deploy.startCommand ?? ''),
    where,
    'migrations must not run from startCommand',
  );
  check(
    /prisma\s+migrate\s+deploy/.test(deploy.preDeployCommand ?? ''),
    where,
    'should run `prisma migrate deploy` as preDeployCommand',
  );
  check(
    deploy.startCommand === 'node dist/main.js',
    where,
    'startCommand must resolve against the API image WORKDIR (/app/apps/api)',
  );
  for (const d of DESTRUCTIVE) {
    check(
      !d.pattern.test(`${deploy.preDeployCommand ?? ''} ${deploy.startCommand ?? ''}`),
      where,
      `deploy command contains ${d.name}`,
    );
  }
}

/**
 * Every NEXT_PUBLIC_* an app reads must be declared as an ARG in that app's Dockerfile.
 *
 * Next.js inlines these at build time, and Docker SILENTLY DISCARDS a --build-arg that no
 * ARG declares. So a variable set correctly on the platform, spelled correctly, still never
 * reaches the build — and nothing errors. The build succeeds, the health check passes, and
 * the app quietly uses its source-level fallback, which is written for local development.
 * Observed in QA: the "Open organizer console" button pointed at http://localhost:3001 and
 * the sitemap advertised the production domain, both while the Railway variables were set.
 */
function validateNextPublicBuildArgs() {
  const apps = ['customer-web', 'organizer-web', 'admin-web'];
  for (const app of apps) {
    const where = `apps/${app}/Dockerfile`;
    const dockerfile = join(ROOT, 'apps', app, 'Dockerfile');
    if (!existsSync(dockerfile)) continue;
    const df = readFileSync(dockerfile, 'utf8');

    // Collect NEXT_PUBLIC_* referenced anywhere in this app's source.
    const used = new Set();
    const walk = (dir) => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        if (entry.name === 'node_modules' || entry.name === '.next') continue;
        const p = join(dir, entry.name);
        if (entry.isDirectory()) walk(p);
        else if (/\.(ts|tsx)$/.test(entry.name)) {
          for (const m of readFileSync(p, 'utf8').matchAll(/process\.env\.(NEXT_PUBLIC_[A-Z0-9_]+)/g))
            used.add(m[1]);
        }
      }
    };
    walk(join(ROOT, 'apps', app));

    for (const name of [...used].sort()) {
      check(
        new RegExp(`^ARG\\s+${name}\\b`, 'm').test(df),
        where,
        `${name} is read by apps/${app} but is not declared as an ARG — Docker discards undeclared build args, so the value never reaches the build and the source fallback ships instead`,
      );
    }
  }
}

/** The apps must honour Railway's injected PORT rather than a pinned one. */
function validatePortBinding() {
  const apiMain = readFileSync(join(ROOT, 'apps/api/src/main.ts'), 'utf8');
  check(
    /config\.get<number>\('PORT'\)/.test(apiMain),
    'apps/api/src/main.ts',
    "must read Railway's injected PORT (falling back to API_PORT)",
  );
  check(
    /app\.listen\(port,\s*'0\.0\.0\.0'\)/.test(apiMain),
    'apps/api/src/main.ts',
    'must bind 0.0.0.0 so the platform health check can reach the container',
  );
  const workerMain = readFileSync(join(ROOT, 'apps/worker/src/main.ts'), 'utf8');
  check(
    /process\.env\.PORT\s*\?\?\s*process\.env\.WORKER_PORT/.test(workerMain),
    'apps/worker/src/main.ts',
    "must read Railway's injected PORT (falling back to WORKER_PORT)",
  );
}

// ── Run ──────────────────────────────────────────────────────────────────────

validateNoStrayConfigs();
validateRootConfig();
SERVICES.forEach(validateServiceConfig);
ENV_TEMPLATES.forEach(validateEnvTemplate);
validateNextPublicBuildArgs();
validatePortBinding();

for (const w of warnings) console.warn(`  warn  ${w}`);

if (failures.length) {
  console.error(`\nRailway deployment configuration: ${failures.length} problem(s) found.\n`);
  for (const f of failures) console.error(`  FAIL  ${f}`);
  console.error('');
  process.exit(1);
}

console.log(
  `Railway deployment configuration OK — ${checks} checks passed across ` +
    `${SERVICES.length} services and ${ENV_TEMPLATES.length} environment templates.`,
);
