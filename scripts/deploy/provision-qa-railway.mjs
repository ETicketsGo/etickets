#!/usr/bin/env node
/**
 * Provision the ETicketsGo QA environment on Railway, idempotently.
 *
 * Written as a script rather than a sequence of dashboard clicks because the QA environment
 * has to be reproducible: if it is torn down, or UAT is built next, the answer should be
 * "re-run this", not "remember what you clicked". Every step is a no-op when the desired
 * state already holds, so it is safe to re-run at any time.
 *
 * Auth: a Railway PROJECT token, read from ~/.railway-qa-token (36-char UUID). A project
 * token is scoped to one project + environment and cannot see any other project — which is
 * exactly the isolation the deployment design depends on. The token is never printed.
 *
 * What it does NOT do, deliberately:
 *   - delete anything (no service, volume or variable is ever removed)
 *   - trigger a deployment (that is GitHub Actions' job — this only prepares the target)
 *   - set payment credentials (they are provider-issued; see QA_FIRST_DEPLOYMENT.md)
 *
 * Usage:
 *   node scripts/deploy/provision-qa-railway.mjs            # apply
 *   node scripts/deploy/provision-qa-railway.mjs --dry-run  # report only, change nothing
 */

import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';

const API = 'https://backboard.railway.app/graphql/v2';
const DRY = process.argv.includes('--dry-run');
const TOKEN_FILE = process.env.RAILWAY_TOKEN_FILE ?? join(homedir(), '.railway-qa-token');

let TOKEN;
try {
  TOKEN = readFileSync(TOKEN_FILE, 'utf8').trim();
} catch {
  console.error(`Cannot read a Railway project token from ${TOKEN_FILE}`);
  process.exit(1);
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
const APP_SERVICES = [
  { name: 'api', config: 'deploy/railway/api.railway.json' },
  { name: 'worker', config: 'deploy/railway/worker.railway.json' },
  { name: 'customer-web', config: 'deploy/railway/customer-web.railway.json' },
  { name: 'organizer-web', config: 'deploy/railway/organizer-web.railway.json' },
  { name: 'admin-web', config: 'deploy/railway/admin-web.railway.json' },
];

const REPO = 'ETicketsGo/etickets';

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

  log(`\nProject "${project.name}"  ·  environment "${envName}"${DRY ? '   [DRY RUN]' : ''}\n`);

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
      act(`${svc.name}: set config-as-code = ${svc.config} (was ${inst?.railwayConfigFile ?? 'unset'})`);
    } else {
      await gql(
        `mutation($e:String!,$s:String!,$in:ServiceInstanceUpdateInput!){ serviceInstanceUpdate(environmentId:$e, serviceId:$s, input:$in) }`,
        { e: environmentId, s: id, in: { railwayConfigFile: svc.config } },
      );
      act(`${svc.name}: config-as-code = ${svc.config}`);
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

    // Volume — durability. Creating a second one errors, so check first.
    const vols = await gql(`query($id:String!){ project(id:$id){ volumes{edges{node{id name}}} } }`, {
      id: projectId,
    });
    const wanted = `${store.name.toLowerCase()}-volume`;
    const hasVol = vols.project.volumes.edges.some((e) => e.node.name === wanted);
    if (hasVol) {
      ok(`${store.name}: volume present (durable)`);
    } else if (DRY) {
      act(`${store.name}: create volume at ${store.mount}`);
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
        await gql(
          `mutation($in:VariableUpsertInput!){ variableUpsert(input:$in) }`,
          { in: { projectId, environmentId, serviceId: id, name, value } },
        );
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
