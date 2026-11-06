#!/usr/bin/env node
/**
 * Promote ONE service of ONE environment to an image digest from a release manifest.
 *
 *   RAILWAY_TOKEN=<project token of THAT environment> \
 *   node scripts/deploy/promote-image.mjs --manifest release-manifest.json --env QA --service api
 *       -> DRY RUN (default): reads the service's current source and prints what would change.
 *
 *   ... --apply                    -> points the service at image@sha256:..., redeploys, waits,
 *                                     and (api) checks /api/health reports the manifest commit.
 *   PROD also needs CONFIRM_PROD_PROMOTE=<service>@<digest>, typed out in full.
 *
 * ROLLBACK is the same command with the previous, already-approved manifest.
 *
 * ── STATUS: NOT YET RUN AGAINST RAILWAY ───────────────────────────────────────────
 * The GraphQL fields used here were read from Railway's schema by introspection on
 * 2026-11-06 (serviceInstanceUpdate.input.source.image, registryCredentials,
 * serviceInstanceRedeploy). Switching a service from a repository source to an image is an
 * infrastructure change: the FIRST --apply must be on QA, with the owner's approval and present,
 * and docs/deployment/IMAGE-PROMOTION.md lists what to check (preDeployCommand still running
 * the migrations, health check, config-as-code interaction, registry credentials).
 *
 * Never prints a variable value or a token. Registry credentials (a GHCR read-only token) come
 * from REGISTRY_USERNAME / REGISTRY_PASSWORD only when the image is private.
 */
import { readFileSync } from 'node:fs';

const arg = (name) => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
};
const apply = process.argv.includes('--apply');
const manifestPath = arg('manifest');
const envName = (arg('env') ?? '').toUpperCase();
const serviceName = arg('service');
const healthUrl = arg('health-url'); // e.g. https://api-qa-xxxx.up.railway.app

if (!manifestPath || !['QA', 'UAT', 'PROD'].includes(envName) || !serviceName) {
  console.error(
    'usage: --manifest <file> --env QA|UAT|PROD --service <name> [--apply] [--health-url <url>]',
  );
  process.exit(2);
}
if (!process.env.RAILWAY_TOKEN) {
  console.error('RAILWAY_TOKEN (the project token of the target environment) is required.');
  process.exit(2);
}

const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
const entry = manifest.images?.[serviceName];
if (!entry?.ref || !/@sha256:[0-9a-f]{64}$/.test(entry.ref)) {
  console.error(`The manifest has no digest-pinned image for "${serviceName}". Refusing a tag.`);
  process.exit(2);
}

async function q(query, variables) {
  for (let i = 0; i < 3; i++) {
    const r = await fetch('https://backboard.railway.com/graphql/v2', {
      method: 'POST',
      headers: {
        'Project-Access-Token': process.env.RAILWAY_TOKEN,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ query, variables }),
    });
    const text = await r.text();
    let j;
    try {
      j = JSON.parse(text);
    } catch {
      await new Promise((s) => setTimeout(s, 2000));
      continue;
    }
    if (j.errors) throw new Error(JSON.stringify(j.errors).slice(0, 400));
    return j.data;
  }
  throw new Error('Railway answered with something that is not JSON, three times.');
}

const token = (await q('query{ projectToken { projectId environmentId } }')).projectToken;
const env = (
  await q(
    `query($id:String!){ environment(id:$id){ name serviceInstances { edges { node {
      serviceId serviceName source { image repo } latestDeployment { id status meta } } } } } }`,
    { id: token.environmentId },
  )
).environment;
const expected = { QA: 'QA', UAT: 'UAT', PROD: 'PROD' }[envName];
if (env.name.toUpperCase() !== expected) {
  console.error(`Refusing: this token belongs to environment "${env.name}", not ${envName}.`);
  process.exit(2);
}
const svc = env.serviceInstances.edges
  .map((e) => e.node)
  .find((n) => n.serviceName === serviceName);
if (!svc) {
  console.error(`No service "${serviceName}" in ${env.name}.`);
  process.exit(2);
}

const plan = {
  environment: env.name,
  service: serviceName,
  current: {
    source: svc.source,
    commit: svc.latestDeployment?.meta?.commitHash ?? null,
    image: svc.latestDeployment?.meta?.image ?? null,
    deployment: svc.latestDeployment?.id ?? null,
  },
  target: { ref: entry.ref, gitSha: manifest.gitSha, version: manifest.version },
  switchesFromRepositoryToImage: Boolean(svc.source?.repo) && !svc.source?.image,
};
console.log(JSON.stringify({ mode: apply ? 'APPLY' : 'DRY RUN', ...plan }, null, 2));
if (!apply) {
  console.log('Dry run only. Nothing was changed. Add --apply to promote.');
  process.exit(0);
}

if (envName === 'PROD') {
  const want = `${serviceName}@${entry.digest}`;
  if (process.env.CONFIRM_PROD_PROMOTE !== want) {
    console.error(`Refusing PROD: set CONFIRM_PROD_PROMOTE=${want} (typed out) to confirm.`);
    process.exit(2);
  }
}

const input = { source: { image: entry.ref } };
if (process.env.REGISTRY_USERNAME && process.env.REGISTRY_PASSWORD) {
  input.registryCredentials = {
    username: process.env.REGISTRY_USERNAME,
    password: process.env.REGISTRY_PASSWORD,
  };
}
await q(
  `mutation($s:String!,$e:String!,$i:ServiceInstanceUpdateInput!){
     serviceInstanceUpdate(serviceId:$s, environmentId:$e, input:$i) }`,
  { s: svc.serviceId, e: token.environmentId, i: input },
);
await q(
  `mutation($s:String!,$e:String!){ serviceInstanceRedeploy(serviceId:$s, environmentId:$e) }`,
  { s: svc.serviceId, e: token.environmentId },
);
console.log('Source updated and redeploy requested. Waiting for the new deployment...');

const before = svc.latestDeployment?.id;
const deadline = Date.now() + 15 * 60 * 1000;
let latest;
while (Date.now() < deadline) {
  await new Promise((s) => setTimeout(s, 10_000));
  const fresh = (
    await q(
      `query($id:String!){ environment(id:$id){ serviceInstances { edges { node {
        serviceName latestDeployment { id status meta } } } } } }`,
      { id: token.environmentId },
    )
  ).environment.serviceInstances.edges
    .map((e) => e.node)
    .find((n) => n.serviceName === serviceName);
  latest = fresh?.latestDeployment;
  if (latest && latest.id !== before && ['SUCCESS', 'FAILED', 'CRASHED'].includes(latest.status))
    break;
}
console.log(JSON.stringify({ deployment: latest?.id, status: latest?.status }, null, 2));
if (latest?.status !== 'SUCCESS') {
  console.error(
    'The new deployment did not succeed. The previous deployment keeps serving if Railway kept it; check the dashboard, then promote the previous manifest to roll back.',
  );
  process.exit(1);
}

// A green deploy proves a container started, not that it is the build we meant.
if (healthUrl) {
  const r = await fetch(new URL('/api/health', healthUrl));
  const body = await r.json().catch(() => ({}));
  const ok = body?.build?.sha === manifest.gitSha && body?.build?.source === 'image';
  console.log(
    JSON.stringify({ health: r.status, build: body?.build ?? null, matchesManifest: ok }),
  );
  if (!ok) process.exit(1);
}
console.log('Promoted.');
