// SETTINGS-FIRST migration of ONE Railway environment from the legacy config files
// (deploy/railway/*.railway.json) to IaC (.railway/railway.ts), WITHOUT deploying anything.
//
// Why: `railway config apply` deploys every service it changes at the head of `main`, all at
// once (docs/deployment/RAILWAY-IAC-MIGRATION.md, trap 5). UAT and PROD do not run `main` HEAD,
// so applying there would be an unplanned code release. Under the legacy files the services'
// own settings are EMPTY (no start command, health check or Dockerfile path: the file supplies
// them), so the path cannot simply be cleared either. This script:
//
//   1. (dry run, default) compiles .railway/railway.ts for the token's environment and lists, per
//      service, the build/deploy settings whose service-level value differs from it.
//   2. --write: writes exactly those settings with serviceInstanceUpdate. While the legacy file
//      is set, the file still wins, so nothing changes for the running service and no
//      deployment starts (verified on QA 2026-11-07).
//   3. --clear-legacy-paths: once a dry run shows 0 pending settings, clears each service's
//      railwayConfigFile. No deployment starts.
//   4. Then `railway config plan --detailed-exit-code` must exit 0: IaC already matches, so a
//      later `config apply` has nothing to deploy. The next normal release builds from these
//      settings.
//
// Never touches: variables, domains, replicas/regions, source, Postgres, Redis, volumes.
// After every write it checks that no service got a new deployment.
//
//   RAILWAY_TOKEN=<that environment's project token> \
//     node --experimental-strip-types scripts/deploy/railway-iac-settings-first.mjs
//   ... --write                 needs CONFIRM_IAC_SETTINGS=<environment name>
//   ... --clear-legacy-paths    needs CONFIRM_IAC_SETTINGS=<environment name>
//
// Exit: 0 nothing pending; 2 settings pending (dry run); 1 error or refusal.
import { createRailwayContext, project } from 'railway/iac';
import { pathToFileURL } from 'node:url';
import path from 'node:path';

const token = process.env.RAILWAY_TOKEN;
if (!token) {
  console.error('Set RAILWAY_TOKEN to the environment project token.');
  process.exit(1);
}
const write = process.argv.includes('--write');
const clearPaths = process.argv.includes('--clear-legacy-paths');
if (write && clearPaths) {
  console.error('One step at a time: --write, then a dry run, then --clear-legacy-paths.');
  process.exit(1);
}

async function gql(query, variables = {}) {
  const res = await fetch('https://backboard.railway.com/graphql/v2', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'Project-Access-Token': token },
    body: JSON.stringify({ query, variables }),
  });
  const body = await res.json();
  if (body.errors) throw new Error(JSON.stringify(body.errors));
  return body.data;
}

const { projectToken } = await gql('{ projectToken { environmentId environment { name } } }');
const envName = projectToken.environment.name;
const environmentId = projectToken.environmentId;
if ((write || clearPaths) && process.env.CONFIRM_IAC_SETTINGS !== envName) {
  console.error(`Refusing: set CONFIRM_IAC_SETTINGS=${envName} to change ${envName}.`);
  process.exit(1);
}

const SETTINGS = `railwayConfigFile builder dockerfilePath startCommand preDeployCommand
  healthcheckPath healthcheckTimeout restartPolicyType restartPolicyMaxRetries cronSchedule
  sleepApplication overlapSeconds drainingSeconds latestDeployment { id status }`;
async function instances() {
  const { environment } = await gql(
    `query($e:String!){ environment(id:$e){ serviceInstances { edges { node { serviceId serviceName } } } } }`,
    { e: environmentId },
  );
  const out = new Map();
  for (const { node } of environment.serviceInstances.edges) {
    const { serviceInstance } = await gql(
      `query($e:String!,$s:String!){ serviceInstance(environmentId:$e, serviceId:$s){ ${SETTINGS} } }`,
      { e: environmentId, s: node.serviceId },
    );
    out.set(node.serviceName, { serviceId: node.serviceId, ...serviceInstance });
  }
  return out;
}

const root = path.resolve(
  path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')),
  '..',
  '..',
);
const mod = await import(pathToFileURL(path.join(root, '.railway', 'railway.ts')).href);
const compiled = await mod.default(
  createRailwayContext({ environment: envName, environmentName: envName }),
  project,
);

/*
  The settings IaC owns, as the service-level value it implies. A field IaC leaves unset means
  "Railway's default" (railway.ts drops defaults on purpose), which the service already holds
  when it was never set, so it is only written when the service holds something else.
*/
const DEFAULTS = {
  preDeployCommand: null,
  healthcheckPath: null,
  cronSchedule: null,
  restartPolicyType: 'ON_FAILURE',
  restartPolicyMaxRetries: 10,
  sleepApplication: false,
};
function desired(r) {
  const d = r.deploy ?? {};
  const want = {
    dockerfilePath: r.build?.dockerfilePath ?? null,
    startCommand: d.startCommand ?? null,
    preDeployCommand: d.preDeployCommand ?? null,
    healthcheckPath: d.healthcheckPath ?? null,
    healthcheckTimeout: d.healthcheckTimeout ?? null,
    restartPolicyType: d.restartPolicyType ?? DEFAULTS.restartPolicyType,
    restartPolicyMaxRetries: d.restartPolicyMaxRetries ?? null,
    cronSchedule: d.cronSchedule ?? null,
    sleepApplication: d.sleepApplication ?? DEFAULTS.sleepApplication,
    overlapSeconds: d.overlapSeconds ?? null,
    drainingSeconds: d.drainingSeconds ?? null,
  };
  if (want.restartPolicyType === 'ON_FAILURE' && want.restartPolicyMaxRetries === null)
    want.restartPolicyMaxRetries = DEFAULTS.restartPolicyMaxRetries;
  return want;
}
const asList = (v) => (Array.isArray(v) ? v : v ? [v] : []);
const norm = (k, v) => {
  if (k === 'preDeployCommand') return JSON.stringify(asList(v));
  return v === undefined || v === '' ? null : v;
};

function pending(inst, want) {
  const out = {};
  for (const [k, v] of Object.entries(want)) {
    // Unset in IaC and unset on the service: Railway's default on both sides.
    if (v === null && (inst[k] === null || inst[k] === '' || inst[k] === undefined)) continue;
    if (v === null) continue; // IaC does not own a value here; never blank a live setting.
    if (norm(k, inst[k]) !== norm(k, v)) out[k] = k === 'preDeployCommand' ? asList(v) : v;
  }
  return out;
}

const before = await instances();
const apps = compiled.resources.filter((x) => x.type === 'service');
console.log(
  `Environment ${envName}: ${write ? 'WRITE' : clearPaths ? 'CLEAR LEGACY PATHS' : 'dry run'}`,
);
let total = 0;
const plan = [];
for (const r of apps) {
  const inst = before.get(r.name);
  if (!inst) {
    console.error(`  ${r.name}: not in ${envName}. Refusing: this script never creates services.`);
    process.exit(1);
  }
  const p = pending(inst, desired(r));
  plan.push({ r, inst, p });
  total += Object.keys(p).length;
  const legacy = inst.railwayConfigFile
    ? ` [legacy ${inst.railwayConfigFile}]`
    : ' [no legacy path]';
  console.log(`  ${Object.keys(p).length ? '~' : '='} ${r.name}${legacy}`);
  for (const [k, v] of Object.entries(p))
    console.log(`      ${k}: ${JSON.stringify(inst[k] ?? null)} -> ${JSON.stringify(v)}`);
}

async function assertNoNewDeployments(label) {
  await new Promise((res) => setTimeout(res, 15000));
  const after = await instances();
  const moved = [...after].filter(
    ([name, i]) =>
      (i.latestDeployment?.id ?? null) !== (before.get(name)?.latestDeployment?.id ?? null),
  );
  if (moved.length) {
    console.error(
      `  ${label}: NEW DEPLOYMENT on ${moved.map(([n]) => n).join(', ')}. Stop and investigate.`,
    );
    process.exit(1);
  }
  console.log(`  ${label}: no service got a new deployment.`);
}

const update = (serviceId, input) =>
  gql(
    `mutation($e:String!,$s:String!,$i:ServiceInstanceUpdateInput!){ serviceInstanceUpdate(environmentId:$e, serviceId:$s, input:$i) }`,
    { e: environmentId, s: serviceId, i: input },
  );

if (write) {
  for (const { r, inst, p } of plan) {
    if (!Object.keys(p).length) continue;
    await update(inst.serviceId, p);
    console.log(`  wrote ${Object.keys(p).length} setting(s) on ${r.name}`);
  }
  await assertNoNewDeployments('after writing');
  process.exit(0);
}

if (clearPaths) {
  if (total) {
    console.error(`Refusing: ${total} setting(s) still differ. Run --write first, then a dry run.`);
    process.exit(1);
  }
  for (const { r, inst } of plan) {
    if (!inst.railwayConfigFile) continue;
    // An empty string clears the path; null is ignored by the API.
    await update(inst.serviceId, { railwayConfigFile: '' });
    console.log(`  cleared the legacy path on ${r.name} (was ${inst.railwayConfigFile})`);
  }
  await assertNoNewDeployments('after clearing');
  console.log('Next: railway config plan --detailed-exit-code must exit 0.');
  process.exit(0);
}

console.log(
  total
    ? `\n${total} setting(s) to write. Nothing was changed (dry run).`
    : '\nNo settings pending.',
);
process.exit(total ? 2 : 0);
