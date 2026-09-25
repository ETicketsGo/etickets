#!/usr/bin/env node
/**
 * Provision one ETicketsGo environment on Railway, idempotently.
 *
 * Written as a script rather than a sequence of dashboard clicks because an environment has
 * to be reproducible: if it is torn down, or the next one is built, the answer should be
 * "re-run this", not "remember what you clicked". Every step is a no-op when the desired
 * state already holds, so it is safe to re-run at any time.
 *
 * ── IT PROVISIONS WHICHEVER ENVIRONMENT THE TOKEN BELONGS TO ───────────────────────
 * A Railway project token is scoped to one project AND one environment, so the token IS the
 * target: there is no environment argument to get wrong, and no way to point this at
 * production by mistyping a flag. It reads back the environment's name and applies that
 * environment's policy — see `policyFor`, where production differs from the rest in ways
 * that matter.
 *
 * Auth: `RAILWAY_TOKEN`, or a file named by `RAILWAY_TOKEN_FILE`. Never printed.
 *
 * What it does NOT do, deliberately:
 *   - delete anything (no service, volume or variable is ever removed)
 *   - rotate a credential that already exists
 *   - trigger a deployment (this only prepares the target)
 *   - set payment credentials (they are provider-issued)
 *
 * Usage:
 *   RAILWAY_TOKEN=... node scripts/deploy/provision-railway-environment.mjs --dry-run
 *   RAILWAY_TOKEN=... node scripts/deploy/provision-railway-environment.mjs
 */

import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';

const API = 'https://backboard.railway.app/graphql/v2';
const DRY = process.argv.includes('--dry-run');
const TOKEN_FILE = process.env.RAILWAY_TOKEN_FILE ?? join(homedir(), '.railway-qa-token');

let TOKEN = (process.env.RAILWAY_TOKEN ?? '').trim();
if (!TOKEN) {
  try {
    TOKEN = readFileSync(TOKEN_FILE, 'utf8').trim();
  } catch {
    console.error(`Set RAILWAY_TOKEN, or put a project token in ${TOKEN_FILE}`);
    process.exit(1);
  }
}
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

const log = (s) => console.log(s);
const act = (s) => console.log(`  ${DRY ? 'WOULD' : 'DID  '} ${s}`);
const ok = (s) => console.log(`  ok   ${s}`);

/** A URL-safe secret. Base64url avoids shell/URL quoting problems in a connection string. */
const secret = (bytes = 36) => randomBytes(bytes).toString('base64url');

// ── The five application services, and the config file each must load ────────────────
// The config path is the single most important setting here: a service without one falls
// back to the repository-root railway.json, which describes the API *including its
// migration pre-deploy command*. An unset path on the worker silently creates a second
// migration executor.
//
// `sleep` enables Railway's app sleeping: the service scales to zero when idle and wakes on
// the next request. On a usage-billed plan that is the difference between paying for seven
// always-on containers and paying for what QA actually uses, which outside working hours is
// close to nothing.
//
// The worker is the one service that must NEVER sleep, and the reason is correctness rather
// than convenience: it owns the `expire-holds` repeatable job. A sleeping worker does not
// release expired seat holds, so inventory stays locked and the symptom presents as phantom
// overselling — the hardest class of bug to diagnose in this system. The few dollars a month
// that costs is not a trade worth making.
const APP_SERVICES = [
  { name: 'api', config: 'deploy/railway/api.railway.json', sleep: true },
  { name: 'worker', config: 'deploy/railway/worker.railway.json', sleep: false },
  { name: 'customer-web', config: 'deploy/railway/customer-web.railway.json', sleep: true },
  { name: 'organizer-web', config: 'deploy/railway/organizer-web.railway.json', sleep: true },
  { name: 'admin-web', config: 'deploy/railway/admin-web.railway.json', sleep: true },
];

const REPO = 'ETicketsGo/etickets';

/**
 * What differs between a test environment and the one customers use.
 *
 * SLEEPING IS A TEST-ENVIRONMENT LUXURY
 * Sleeping idle services is the right call in QA and UAT: nobody is waiting, and the few
 * dollars a month are worth having. In production it is two separate faults.
 *
 * A sleeping API makes the first customer of the day wait for a cold start, on the page where
 * they are deciding whether to trust us with a card. Worse, a payment PROVIDER does not retry
 * forever: Razorpay posts a webhook when money moves, and a webhook that arrives at a service
 * still waking up is a payment the platform may never hear about - a customer charged with no
 * ticket, found days later in a reconciliation report. Nothing about that is worth saving a
 * few dollars a month on.
 *
 * AUTOMATIC DEPLOYS ARE OFF IN PRODUCTION
 * This project has already had main auto-deploy to an unapproved production environment once.
 * A merge is a decision to have code reviewed; it is not a decision to put it in front of
 * paying customers. Production is deployed on purpose, by somebody, with the deploy script.
 */
function policyFor(environmentName) {
  const isProduction = /^prod/i.test(environmentName);
  return {
    isProduction,
    /** Only test environments sleep. See above for what it costs in production. */
    allowSleep: !isProduction,
    /** Deploys are triggered deliberately in production, never by a push. */
    autoDeploy: !isProduction,
  };
}

async function main() {
  // ── Identify the project this token belongs to ──────────────────────────────────
  const { projectToken } = await gql('{ projectToken { projectId environmentId } }');
  const { projectId, environmentId } = projectToken;

  const { project } = await gql(
    `query($id:String!){ project(id:$id){ name services{edges{node{id name}}} environments{edges{node{id name}}} } }`,
    { id: projectId },
  );
  const envName =
    project.environments.edges.find((e) => e.node.id === environmentId)?.node.name ?? '?';

  const policy = policyFor(envName);
  log(`
Project "${project.name}"  ·  environment "${envName}"${DRY ? '   [DRY RUN]' : ''}`);
  log(
    policy.isProduction
      ? '  PRODUCTION policy: nothing sleeps, and pushes do not deploy.\n'
      : '  Test-environment policy: idle services sleep; the worker never does.\n',
  );

  const byName = new Map(project.services.edges.map((e) => [e.node.name, e.node.id]));

  // ── Application services ────────────────────────────────────────────────────────
  log('Application services');
  for (const svc of APP_SERVICES) {
    let id = byName.get(svc.name);
    if (!id) {
      if (DRY) {
        act(`create service "${svc.name}" from ${REPO}`);
        continue;
      }
      const r = await gql(
        `mutation($in:ServiceCreateInput!){ serviceCreate(input:$in){ id name } }`,
        {
          in: { projectId, environmentId, name: svc.name, source: { repo: REPO } },
        },
      );
      id = r.serviceCreate.id;
      byName.set(svc.name, id);
      act(`created service "${svc.name}"`);
    }

    const cur = await gql(
      `query($id:String!){ service(id:$id){ serviceInstances{edges{node{ environmentId railwayConfigFile rootDirectory }}} } }`,
      { id },
    );
    const inst = cur.service.serviceInstances.edges.find(
      (e) => e.node.environmentId === environmentId,
    )?.node;

    if (inst?.railwayConfigFile === svc.config) {
      ok(`${svc.name}: config-as-code = ${svc.config}`);
    } else if (DRY) {
      act(
        `${svc.name}: set config-as-code = ${svc.config} (was ${inst?.railwayConfigFile ?? 'unset'})`,
      );
    } else {
      await gql(
        `mutation($e:String!,$s:String!,$in:ServiceInstanceUpdateInput!){ serviceInstanceUpdate(environmentId:$e, serviceId:$s, input:$in) }`,
        { e: environmentId, s: id, in: { railwayConfigFile: svc.config } },
      );
      act(`${svc.name}: config-as-code = ${svc.config}`);
    }

    /*
      Cost control in a test environment; a correctness setting in production.

      The worker never sleeps anywhere - it owns the `expire-holds` repeatable job, and a
      sleeping worker does not release expired seat holds, so inventory stays locked and the
      symptom presents as phantom overselling. In production NOTHING sleeps, for the reasons
      set out in `policyFor`.
    */
    const sleep = policy.allowSleep && svc.sleep;
    const why = !svc.sleep
      ? '  <- must stay awake: owns expire-holds'
      : policy.isProduction
        ? '  <- production never sleeps: cold starts and missed payment webhooks'
        : '';
    if (DRY) {
      act(`${svc.name}: sleepApplication=${sleep}, numReplicas=1${why}`);
    } else {
      await gql(
        `mutation($e:String!,$s:String!,$in:ServiceInstanceUpdateInput!){ serviceInstanceUpdate(environmentId:$e, serviceId:$s, input:$in) }`,
        { e: environmentId, s: id, in: { sleepApplication: sleep, numReplicas: 1 } },
      );
      act(`${svc.name}: sleep=${sleep}, replicas=1${why}`);
    }

    // Root directory must stay empty: every Dockerfile builds from the repository root
    // and COPYs each workspace manifest before a single npm ci.
    if (inst && inst.rootDirectory) {
      if (DRY) act(`${svc.name}: clear rootDirectory (is "${inst.rootDirectory}")`);
      else {
        await gql(
          `mutation($e:String!,$s:String!,$in:ServiceInstanceUpdateInput!){ serviceInstanceUpdate(environmentId:$e, serviceId:$s, input:$in) }`,
          { e: environmentId, s: id, in: { rootDirectory: null } },
        );
        act(`${svc.name}: cleared rootDirectory`);
      }
    }
  }

  // ── Datastores ──────────────────────────────────────────────────────────────────
  // Created as image services with an attached volume. Railway's dashboard "Add
  // Database" button does the same thing with a nicer preset; doing it here keeps the
  // whole environment reproducible from one command. The volume is what makes the data
  // durable — without it a redeploy silently wipes the database.
  log('\nDatastores');
  const stores = [
    {
      name: 'Postgres',
      image: 'ghcr.io/railwayapp-templates/postgres-ssl:16',
      mount: '/var/lib/postgresql/data',
      vars: () => {
        const pw = secret(24);
        return {
          POSTGRES_USER: 'postgres',
          POSTGRES_PASSWORD: pw,
          POSTGRES_DB: 'railway',
          PGDATA: '/var/lib/postgresql/data/pgdata',
          DATABASE_URL: `postgresql://postgres:${pw}@\${{RAILWAY_PRIVATE_DOMAIN}}:5432/railway`,
        };
      },
    },
    {
      name: 'Redis',
      image: 'bitnami/redis:7.2.5',
      mount: '/bitnami/redis/data',
      vars: () => {
        const pw = secret(24);
        return {
          REDIS_PASSWORD: pw,
          REDIS_URL: `redis://default:${pw}@\${{RAILWAY_PRIVATE_DOMAIN}}:6379`,
        };
      },
    },
  ];

  for (const store of stores) {
    let id = byName.get(store.name);
    if (!id) {
      if (DRY) {
        act(`create ${store.name} (${store.image}) + volume at ${store.mount}`);
        continue;
      }
      const r = await gql(
        `mutation($in:ServiceCreateInput!){ serviceCreate(input:$in){ id name } }`,
        {
          in: { projectId, environmentId, name: store.name, source: { image: store.image } },
        },
      );
      id = r.serviceCreate.id;
      byName.set(store.name, id);
      act(`created ${store.name}`);
    } else {
      ok(`${store.name}: exists`);
    }

    /*
      Volume - durability, and the check has to be per ENVIRONMENT.

      This asked the PROJECT whether a volume of this name existed anywhere, which is the same
      question for every environment in the project. Once QA had `postgres-volume`, a run
      against PROD reported "volume present (durable)" and created none - and a Postgres with
      no volume loses everything on the next redeploy. Caught on a dry run before production
      was provisioned; the report was reassuring and wrong, which is the worst kind.

      A volume INSTANCE is the thing that is per-environment, so that is what is counted.
    */
    const vols = await gql(
      `query($e:String!){ environment(id:$e){ volumeInstances{edges{node{ volume{ name } service{ id } }}} } }`,
      { e: environmentId },
    );
    const here = (vols.environment.volumeInstances?.edges ?? []).map((n) => n.node);
    const hasVol = here.some((v) => v.service?.id === id);
    if (hasVol) {
      ok(`${store.name}: volume present in this environment (durable)`);
    } else if (DRY) {
      act(`${store.name}: create volume at ${store.mount}  <- NONE in this environment`);
    } else {
      await gql(`mutation($in:VolumeCreateInput!){ volumeCreate(input:$in){ id name } }`, {
        in: { projectId, environmentId, serviceId: id, mountPath: store.mount },
      });
      act(`${store.name}: volume created at ${store.mount}`);
    }

    // Credentials — only generated if absent, so re-running never rotates a live password.
    const existing = await gql(
      `query($e:String!,$s:String!,$p:String!){ variables(environmentId:$e, serviceId:$s, projectId:$p) }`,
      { e: environmentId, s: id, p: projectId },
    );
    const key = store.name === 'Postgres' ? 'DATABASE_URL' : 'REDIS_URL';
    if (existing.variables[key]) {
      ok(`${store.name}: credentials already set (left untouched)`);
    } else if (DRY) {
      act(`${store.name}: generate credentials + ${key}`);
    } else {
      const vars = store.vars();
      for (const [name, value] of Object.entries(vars)) {
        await gql(`mutation($in:VariableUpsertInput!){ variableUpsert(input:$in) }`, {
          in: { projectId, environmentId, serviceId: id, name, value },
        });
      }
      act(`${store.name}: generated credentials (${Object.keys(vars).join(', ')})`);
    }
  }

  // ── Summary ─────────────────────────────────────────────────────────────────────
  const final = await gql(
    `query($id:String!){ project(id:$id){ services{edges{node{id name serviceInstances{edges{node{environmentId railwayConfigFile}}}}}} volumes{edges{node{name}}} } }`,
    { id: projectId },
  );
  log('\nFinal state');
  for (const e of final.project.services.edges) {
    const inst = e.node.serviceInstances.edges.find((x) => x.node.environmentId === environmentId);
    log(`  ${e.node.name.padEnd(15)} config=${inst?.node.railwayConfigFile ?? '(none)'}`);
  }
  log(`  volumes: ${final.project.volumes.edges.map((v) => v.node.name).join(', ') || '(none)'}`);
  log('');
}

main().catch((e) => {
  console.error(`\nprovisioning failed: ${e.message}\n`);
  process.exit(1);
});
