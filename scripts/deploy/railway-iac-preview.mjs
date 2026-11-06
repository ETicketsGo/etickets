#!/usr/bin/env node
// READ-ONLY preview of what .railway/railway.ts would change in ONE Railway environment,
// compared with what that environment ACTUALLY RUNS today (the resolved manifest of each
// service's latest deployment, which includes the legacy deploy/railway/*.railway.json).
//
// Use it before migrating UAT or PROD: `railway config plan` refuses to run there until the
// legacy Config File path is cleared, and clearing it is the first irreversible-ish step. This
// shows the behavioural difference first, without touching anything.
//
//   RAILWAY_TOKEN=<that environment's project token> \
//     node --experimental-strip-types scripts/deploy/railway-iac-preview.mjs
//
// Sends GraphQL queries only. Prints variable NAMES, never values. Exit 0 = the IaC file
// reproduces today's settings exactly; 2 = differences (listed); 1 = error.
import { createRailwayContext, project } from 'railway/iac';
import { pathToFileURL } from 'node:url';
import path from 'node:path';

const token = process.env.RAILWAY_TOKEN;
if (!token) {
  console.error('Set RAILWAY_TOKEN to the environment project token.');
  process.exit(1);
}
async function gql(query, variables = {}) {
  if (/^\s*mutation/i.test(query)) throw new Error('read-only script');
  const res = await fetch('https://backboard.railway.com/graphql/v2', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'Project-Access-Token': token },
    body: JSON.stringify({ query, variables }),
  });
  const body = await res.json();
  if (body.errors) throw new Error(JSON.stringify(body.errors));
  return body.data;
}

const { projectToken } = await gql(
  '{ projectToken { environmentId projectId environment { name } } }',
);
const envName = projectToken.environment.name;
const { environment } = await gql(
  `query($e:String!){ environment(id:$e){ serviceInstances { edges { node {
     serviceId serviceName railwayConfigFile
     domains { customDomains { domain targetPort } }
     latestDeployment { id status meta } } } } } }`,
  { e: projectToken.environmentId },
);

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

const FIELDS = {
  build: ['builder', 'dockerfilePath'],
  deploy: [
    'startCommand',
    'preDeployCommand',
    'healthcheckPath',
    'healthcheckTimeout',
    'restartPolicyType',
    'restartPolicyMaxRetries',
    'cronSchedule',
    'multiRegionConfig',
    'sleepApplication',
    'overlapSeconds',
    'drainingSeconds',
  ],
};
/** Railway's defaults (a default is stored as null; railway.ts drops them on purpose). */
const DEFAULTS = { restartPolicyType: 'ON_FAILURE', sleepApplication: false };
const withDefaults = (deploy = {}) => {
  const out = {
    ...DEFAULTS,
    ...Object.fromEntries(Object.entries(deploy).filter(([, v]) => v !== null && v !== undefined)),
  };
  if (out.restartPolicyType === 'ON_FAILURE')
    out.restartPolicyMaxRetries = out.restartPolicyMaxRetries ?? 10;
  return out;
};
const norm = (v) =>
  v === undefined || v === null || (Array.isArray(v) && v.length === 0) ? null : v;
const same = (a, b) => JSON.stringify(norm(a)) === JSON.stringify(norm(b));

let differences = 0;
const say = (s) => console.log(s);
say(`Environment ${envName} (partial "${mod.partial}")`);
for (const r of compiled.resources.filter((x) => x.type === 'service')) {
  const inst = environment.serviceInstances.edges
    .map((e) => e.node)
    .find((n) => n.serviceName === r.name);
  if (!inst) {
    say(`  + ${r.name}: NOT in ${envName} (IaC would create it)`);
    differences++;
    continue;
  }
  const manifest = inst.latestDeployment?.meta?.serviceManifest ?? {};
  const lines = [];
  for (const [section, keys] of Object.entries(FIELDS)) {
    for (const k of keys) {
      const now = section === 'deploy' ? withDefaults(manifest.deploy)[k] : manifest[section]?.[k];
      const next = section === 'deploy' ? withDefaults(r.deploy)[k] : r[section]?.[k];
      // Unset in IaC means "Railway default", which is what an unset legacy field meant too.
      if (next === undefined && (now === undefined || now === null)) continue;
      if (!same(now, next))
        lines.push(
          `${section}.${k}: ${JSON.stringify(norm(now))} -> ${JSON.stringify(norm(next))}`,
        );
    }
  }
  const domainsNow = inst.domains.customDomains.map((d) => d.domain).sort();
  const domainsNext = Object.keys(r.networking?.customDomains ?? {}).sort();
  if (!same(domainsNow, domainsNext))
    lines.push(`domains: ${JSON.stringify(domainsNow)} -> ${JSON.stringify(domainsNext)}`);
  const v = await gql(
    `query($p:String!,$e:String!,$s:String!){ variables(projectId:$p, environmentId:$e, serviceId:$s, unrendered:true) }`,
    { p: projectToken.projectId, e: projectToken.environmentId, s: inst.serviceId },
  );
  const namesNow = Object.keys(v.variables).filter(
    (n) => !n.startsWith('RAILWAY_') || n === 'RAILWAY_RUN_UID',
  );
  const namesNext = Object.keys(r.variables ?? {});
  const removed = namesNow.filter((n) => !namesNext.includes(n));
  const added = namesNext.filter((n) => !namesNow.includes(n));
  if (removed.length) lines.push(`variables that IaC would DELETE: ${removed.join(', ')}`);
  if (added.length)
    lines.push(`variables listed but absent (preserve of nothing): ${added.join(', ')}`);
  const tag = inst.railwayConfigFile
    ? ` [legacy config ${inst.railwayConfigFile}: clear before plan]`
    : '';
  say(
    `  ${lines.length ? '~' : '='} ${r.name} (now: deployment ${inst.latestDeployment?.id?.slice(0, 8)} ${inst.latestDeployment?.status})${tag}`,
  );
  for (const l of lines) say(`      ${l}`);
  differences += lines.length;
}
say(
  differences
    ? `\n${differences} difference(s).`
    : '\nNo behavioural difference: IaC reproduces what runs today.',
);
process.exit(differences ? 2 : 0);
