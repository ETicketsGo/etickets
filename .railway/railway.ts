// ETicketsGo Railway project, as Infrastructure as Code (replaces deploy/railway/*.railway.json,
// which Railway stops reading on 2026-12-01). One file describes all three environments; the
// differences are keyed on ctx.environment ("QA", "UAT", "PROD").
//
// What this file manages: build (Dockerfile), start / pre-deploy commands, health checks,
// restart policy, replicas, sleep, the db-seed schedule and volume mount, custom domains.
//
// Ownership is a NAMED PARTIAL ("apps"): this file owns only the six app services and the
// db-seed volume. Postgres, Redis and their volumes are NOT declared, so a plan can never touch
// them. (Declaring them with the stock postgres()/redis() helpers planned an image change from
// postgres-ssl:16 to postgres:18 and redis:7-alpine to redis:8 in every environment.)
//
// Variable VALUES never appear here. Railway IaC deletes a variable that a managed service
// does not list (omitting `env` planned 221 deletions on QA), so every existing variable NAME
// is listed per environment in ./variables.ts and marked preserve(): Railway keeps its value.
// Regenerate that list with scripts/deploy/railway-iac-variable-names.mjs.
//
// Rules carried over from the legacy files (do not lose them):
// - api is the ONLY migration executor (preDeploy). worker and web never migrate.
// - Deploy order in a promotion: api first, then worker, then the web apps.
// - db-seed restart policy NEVER is required: a restart loop of a destructive operation
//   would repeatedly wipe the environment. Its command never changes; SEED_OPERATION selects
//   the work (prisma/seed-operation.ts).
// - worker serves health on PORT but is internal-only: no public domain.
// - Root Directory stays "/" for every service (Dockerfiles build from the monorepo root).
//
// Plan/apply target the environment of the token in use. A Railway project token is scoped to
// ONE environment, so a QA token can only ever plan or apply QA.

import { defineRailway, github, preserve, project, service, volume } from 'railway/iac';
import { VARIABLE_NAMES } from './variables.ts';

/** Ownership boundary: resources not declared here (databases) are left alone. */
export const partial = 'apps';

type Env = 'QA' | 'UAT' | 'PROD';
type Domain = string | { domain: string; port?: number };

/** Per-environment differences. Every other setting is the same in all three. */
const ENVIRONMENTS: Record<
  Env,
  {
    apiReplicas: number;
    /** Railway sleep-when-idle. Never on in PROD. */
    sleep: { api: boolean; web: boolean };
    domains: { api: Domain[]; customer: Domain[]; organizer: Domain[]; admin: Domain[] };
    /**
     * api deploy overlap / draining (seconds). Draining must cover the server's 120 s request
     * timeout, or a redeploy cuts in-flight requests: on QA 2026-11-06, unset -> 15 of 48
     * 90-second requests cut with 502; 20/120 -> 0 of 48 (RAILWAY-IAC-MIGRATION.md section 7).
     * null = Railway default. UAT/PROD stay null until the owner approves (AR-22).
     */
    apiRollout: { overlapSeconds: number; drainingSeconds: number } | null;
    /** The db-seed backup volume as it exists in that environment. */
    seedVolume: { name: string; sizeMB: number };
  }
> = {
  QA: {
    // AR-04: 2 api replicas on QA only (owner decision 2026-11-06).
    apiReplicas: 2,
    sleep: { api: false, web: true },
    domains: {
      api: ['api-qa.eticketsgo.com'],
      customer: [{ domain: 'qa.eticketsgo.com', port: 8080 }],
      organizer: ['organizer-qa.eticketsgo.com'],
      admin: ['admin-qa.eticketsgo.com'],
    },
    apiRollout: { overlapSeconds: 20, drainingSeconds: 120 },
    seedVolume: { name: 'db-seed-volume', sizeMB: 5000 },
  },
  UAT: {
    apiReplicas: 1,
    sleep: { api: true, web: true },
    // UAT has no custom domains yet.
    domains: { api: [], customer: [], organizer: [], admin: [] },
    apiRollout: null,
    seedVolume: { name: 'db-seed-volume-CmA4', sizeMB: 5000 },
  },
  PROD: {
    // Unchanged (1) until the owner approves more (AR-04).
    apiReplicas: 1,
    sleep: { api: false, web: false },
    domains: {
      api: [{ domain: 'api.eticketsgo.com', port: 8080 }],
      customer: [{ domain: 'www.eticketsgo.com', port: 8080 }],
      organizer: ['organizer.eticketsgo.com'],
      admin: ['admin.eticketsgo.com'],
    },
    apiRollout: null,
    seedVolume: { name: 'db-seed-volume', sizeMB: 5000 },
  },
};

const REGION = 'us-west2';

export default defineRailway((ctx) => {
  const env = ENVIRONMENTS[ctx.environment as Env];
  if (!env) {
    throw new Error(
      `Unknown Railway environment "${ctx.environment}". Add it to ENVIRONMENTS first.`,
    );
  }

  const repo = github('ETicketsGo/etickets');
  const dockerfile = (path: string) => ({
    builder: 'DOCKERFILE' as const,
    buildEnvironment: 'V3' as const,
    dockerfilePath: path,
  });

  /**
   * Railway stores a setting that equals its default as null, so writing the default makes
   * every plan show a change (null -> "ON_FAILURE") forever. Defaults are therefore dropped
   * here; the values above stay readable. Railway defaults: restart ON_FAILURE with 10
   * retries, no sleep. (The validator and railway-iac-preview.mjs apply the same rule.)
   */
  const withoutDefaults = <T extends Record<string, unknown>>(deploy: T): T => {
    const out: Record<string, unknown> = { ...deploy };
    if (out.restartPolicyType === 'ON_FAILURE') {
      delete out.restartPolicyType;
      if (out.restartPolicyMaxRetries === 10) delete out.restartPolicyMaxRetries;
    }
    if (out.sleepApplication === false) delete out.sleepApplication;
    return out as T;
  };

  type AppService = 'api' | 'worker' | 'customer-web' | 'organizer-web' | 'admin-web' | 'db-seed';
  const vars = VARIABLE_NAMES[ctx.environment as Env] as Record<AppService, readonly string[]>;
  /** Keep every variable the service already has, with the value Railway holds. */
  const keep = (svc: AppService) => Object.fromEntries(vars[svc].map((n) => [n, preserve()]));

  const dbSeedVolume = volume(env.seedVolume.name, {
    alerts: { usage: { '100': {}, '80': {}, '95': {} } },
    allowOnlineResize: true,
    region: REGION,
    sizeMB: env.seedVolume.sizeMB,
  });

  // NestJS API: the single migration executor. preDeploy runs once per deployment, before any
  // replica takes traffic; a non-zero exit fails the deploy. Image WORKDIR is /app/apps/api.
  const api = service('api', {
    source: repo,
    build: dockerfile('apps/api/Dockerfile'),
    preDeploy: 'npx prisma migrate deploy',
    start: 'node dist/main.js',
    healthcheck: '/api/health',
    healthcheckTimeout: 60,
    deploy: withoutDefaults({
      restartPolicyType: 'ON_FAILURE',
      restartPolicyMaxRetries: 5,
      sleepApplication: env.sleep.api,
      ...(env.apiRollout ?? {}),
    }),
    replicas: { [REGION]: env.apiReplicas },
    domains: env.domains.api,
    env: keep('api'),
  });

  // BullMQ worker: never migrates; health on PORT; internal-only (no domain).
  const worker = service('worker', {
    source: repo,
    build: dockerfile('apps/worker/Dockerfile'),
    start: 'node dist/main.js',
    healthcheck: '/health',
    healthcheckTimeout: 60,
    deploy: withoutDefaults({
      restartPolicyType: 'ON_FAILURE',
      restartPolicyMaxRetries: 10,
      sleepApplication: false,
    }),
    replicas: { [REGION]: 1 },
    env: keep('worker'),
  });

  // Next.js standalone apps; /api/health is a static route (no DB or API calls).
  const web = (name: 'customer-web' | 'organizer-web' | 'admin-web', domains: Domain[]) =>
    service(name, {
      source: repo,
      build: dockerfile(`apps/${name}/Dockerfile`),
      start: `node apps/${name}/server.js`,
      healthcheck: '/api/health',
      healthcheckTimeout: 60,
      deploy: withoutDefaults({
        restartPolicyType: 'ON_FAILURE',
        restartPolicyMaxRetries: 5,
        sleepApplication: env.sleep.web,
      }),
      replicas: { [REGION]: 1 },
      domains,
      env: keep(name),
    });
  const customerWeb = web('customer-web', env.domains.customer);
  const organizerWeb = web('organizer-web', env.domains.organizer);
  const adminWeb = web('admin-web', env.domains.admin);

  // Seed / backup job on the API image. Nightly 02:00 UTC: with SEED_OPERATION unset it falls
  // back to SEED_DEFAULT_OPERATION=backup (verified pg_dump to /backups); see
  // docs/deployment/RAILWAY_BACKUP_RECOVERY.md section 11. No health check: it serves nothing.
  const dbSeed = service('db-seed', {
    source: repo,
    build: dockerfile('apps/api/Dockerfile'),
    start:
      'npx ts-node --transpile-only --compiler-options \'{"module":"commonjs","moduleResolution":"node"}\' prisma/seed-operation.ts',
    deploy: withoutDefaults({
      restartPolicyType: 'NEVER',
      cronSchedule: '0 2 * * *',
      sleepApplication: false,
    }),
    replicas: { [REGION]: 1 },
    volumeMounts: { '/backups': dbSeedVolume },
    env: keep('db-seed'),
  });

  return project('ETicketsGo', {
    resources: [api, worker, customerWeb, organizerWeb, adminWeb, dbSeed, dbSeedVolume],
  });
});
