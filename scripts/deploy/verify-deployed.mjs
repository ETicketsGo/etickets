#!/usr/bin/env node
/**
 * Is what is RUNNING the same as what is MERGED?
 *
 * ── WHY THIS EXISTS ────────────────────────────────────────────────────────────────
 * "Why isn't my change showing?" has been asked several times on this project, and the
 * answer has been different every time: once the code genuinely was not written, once it
 * was written for a different page, and twice a service was simply running an older build
 * because only `api` had been redeployed. Those look identical from a browser.
 *
 * A deploy reporting SUCCESS proves a container started. It does not prove the container
 * holds the commit you merged, and nothing in the Railway dashboard puts the two side by
 * side. So this does — one command, every service, against `origin/main`.
 *
 * ── WHY IT ALSO CHECKS A BEHAVIOUR ─────────────────────────────────────────────────
 * A matching commit hash still is not proof the running process reflects it: a build can
 * succeed while serving a stale cached bundle, and a web app can be current while the API
 * it talks to is not. So each service is also asked for a FACT only the current code can
 * produce. A hash is what was deployed; a fact is what is answering.
 *
 * Usage:
 *   RAILWAY_TOKEN=<qa or uat token> node scripts/deploy/verify-deployed.mjs
 *   ... --json          machine-readable, for a pipeline
 *
 * Exit code is 1 when anything is behind or any probe fails, so it can gate a release.
 */

import { execSync } from 'node:child_process';

const RAILWAY = 'https://backboard.railway.app/graphql/v2';
const TOKEN = process.env.RAILWAY_TOKEN;
const JSON_OUT = process.argv.includes('--json');

if (!TOKEN) {
  console.error('RAILWAY_TOKEN is not set. See the deploying-QA/UAT notes for where it lives.');
  process.exit(1);
}

/** Services that hold application code. Postgres/Redis have no commit to compare. */
const CODE_SERVICES = ['api', 'worker', 'customer-web', 'organizer-web', 'admin-web'];

const c = {
  red: (s) => `\x1b[31m${s}\x1b[0m`,
  green: (s) => `\x1b[32m${s}\x1b[0m`,
  yellow: (s) => `\x1b[33m${s}\x1b[0m`,
  dim: (s) => `\x1b[2m${s}\x1b[0m`,
  bold: (s) => `\x1b[1m${s}\x1b[0m`,
};

async function gql(query, variables = {}, attempt = 1) {
  const res = await fetch(RAILWAY, {
    method: 'POST',
    headers: { 'Project-Access-Token': TOKEN, 'Content-Type': 'application/json' },
    body: JSON.stringify({ query, variables }),
  });
  const text = await res.text();
  /*
    Read as text first, then parse.

    Railway's gateway intermittently answers a burst of queries with a plain-text
    "Internal Server Error". Calling `res.json()` on that throws `Unexpected token 'I'`,
    which tells the reader nothing about what went wrong or that it is worth retrying —
    the first run of this script failed exactly that way and looked like a bug in the query.
  */
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    if (attempt < 3) {
      await new Promise((r) => setTimeout(r, 400 * attempt));
      return gql(query, variables, attempt + 1);
    }
    throw new Error(`Railway returned HTTP ${res.status}: ${text.slice(0, 120)}`);
  }
  if (body.errors) throw new Error(body.errors.map((e) => e.message).join('; '));
  return body.data;
}

/**
 * Facts only the current code can produce.
 *
 * Each is a field or string that did not exist before a recent change, so a stale build
 * fails it even when its commit hash looks plausible. Keep these CHEAP and PUBLIC — this
 * runs against a live environment and must not need a login or write anything.
 *
 * When you ship something worth guaranteeing, add a probe. When a probe stops being
 * interesting because everything predates it, replace it rather than accumulating.
 */
const PROBES = [
  {
    service: 'api',
    what: 'events carry a country filter',
    run: async (base) => {
      const r = await fetch(`${base}/api/public/events?country=IN&pageSize=1`);
      const j = await r.json();
      return typeof j?.meta?.total === 'number' || 'no paged result for ?country=';
    },
  },
  {
    service: 'api',
    what: 'metrics are not readable by the public internet',
    /*
      This is a drift probe, not a feature probe. `/api/metrics` publishes
      `etg_gmv_minor_total` and the payment counters, and it was public on QA and UAT for
      as long as it existed because the only thing stopping it was a comment saying it
      "MUST be network-restricted" — a control the platform has nowhere to apply.

      Asserted as "not 200" rather than "is 401", because 404 is the correct answer in a
      deployment that has no METRICS_TOKEN set at all, and both are closed.
    */
    run: async (base) => {
      const r = await fetch(`${base}/api/metrics`);
      return r.status !== 200 || `GET /api/metrics is ${r.status} to an anonymous caller`;
    },
  },
  {
    service: 'api',
    what: 'location resolve separates the guess from the safe scope',
    run: async (base) => {
      const r = await fetch(`${base}/api/public/location/resolve?region=de`);
      const j = await r.json();
      return 'scopeCountry' in j || 'resolve has no scopeCountry — pre-country-scoping build';
    },
  },
  {
    service: 'api',
    what: 'cities are searchable rather than dumped',
    run: async (base) => {
      const r = await fetch(`${base}/api/public/location/cities?q=zzzzzz&limit=5`);
      const j = await r.json();
      return (Array.isArray(j) && j.length === 0) || 'city search ignored ?q=';
    },
  },
  {
    service: 'customer-web',
    what: 'the storefront answers as itself',
    run: async (base) => {
      const r = await fetch(`${base}/api/health`);
      const j = await r.json().catch(() => ({}));
      return j?.app === 'customer-web' || `health said ${JSON.stringify(j).slice(0, 60)}`;
    },
  },
];

function mergedHead() {
  try {
    execSync('git fetch origin main --quiet', { stdio: 'ignore' });
  } catch {
    /* offline is survivable; the local ref is then the best available answer */
  }
  return execSync('git rev-parse origin/main').toString().trim();
}

const short = (sha) => (sha ?? '').slice(0, 7);

async function main() {
  const head = mergedHead();
  const {
    projectToken: { projectId, environmentId },
  } = await gql('{ projectToken { projectId environmentId } }');
  const { projectToken } = await gql('{ projectToken { project { name } environment { name } } }');
  const envName = projectToken.environment.name;

  const { project } = await gql(
    `query($id:String!){project(id:$id){services{edges{node{id name}}}}}`,
    { id: projectId },
  );

  const rows = [];
  const domains = {};
  for (const edge of project.services.edges) {
    const { id, name } = edge.node;
    if (!CODE_SERVICES.includes(name)) continue;

    const dep = await gql(
      `query($p:String!,$e:String!,$s:String!){deployments(first:1,input:{projectId:$p,environmentId:$e,serviceId:$s}){edges{node{status meta}}}}`,
      { p: projectId, e: environmentId, s: id },
    );
    const node = dep.deployments.edges[0]?.node;

    const inst = await gql(
      `query($id:String!){service(id:$id){serviceInstances{edges{node{domains{serviceDomains{domain}customDomains{domain}}}}}}}`,
      { id },
    );
    const d = inst.service.serviceInstances.edges[0]?.node?.domains;
    const host = d?.customDomains?.[0]?.domain ?? d?.serviceDomains?.[0]?.domain ?? null;
    if (host) domains[name] = `https://${host}`;

    rows.push({
      service: name,
      status: node?.status ?? 'NONE',
      commit: node?.meta?.commitHash ?? null,
      current: node?.meta?.commitHash === head,
    });
  }

  // Probes run only against services whose host is known; a sleeping service wakes on the
  // request, which is the same thing a visitor would do to it.
  const probes = [];
  for (const probe of PROBES) {
    const base = domains[probe.service];
    if (!base) {
      probes.push({ ...probe, ok: false, detail: 'no public hostname', run: undefined });
      continue;
    }
    let ok = false;
    let detail = '';
    try {
      const result = await probe.run(base);
      ok = result === true;
      if (!ok) detail = typeof result === 'string' ? result : 'probe returned false';
    } catch (err) {
      detail = err.message;
    }
    probes.push({ service: probe.service, what: probe.what, ok, detail });
  }

  const behind = rows.filter((r) => !r.current);
  const failed = probes.filter((p) => !p.ok);

  if (JSON_OUT) {
    console.log(JSON.stringify({ environment: envName, head, services: rows, probes }, null, 2));
  } else {
    console.log(c.bold(`\nDeployed vs merged — ${envName}`));
    console.log(c.dim(`origin/main is ${short(head)}\n`));
    for (const r of rows) {
      const mark = r.current ? c.green('current') : c.red('BEHIND ');
      console.log(
        `  ${mark}  ${r.service.padEnd(14)} ${short(r.commit) || c.dim('—')}  ${c.dim(r.status)}`,
      );
    }
    console.log(c.bold('\nBehaviour probes'));
    for (const p of probes) {
      const mark = p.ok ? c.green('pass') : c.red('FAIL');
      console.log(
        `  ${mark}  ${p.service.padEnd(14)} ${p.what}${p.ok ? '' : c.dim(` — ${p.detail}`)}`,
      );
    }
    if (behind.length) {
      console.log(
        c.yellow(
          `\n${behind.length} service(s) behind. Redeploy:\n` +
            behind
              .map((r) => `  node scripts/deploy/railway-deploy-and-wait.mjs ${r.service}`)
              .join('\n'),
        ),
      );
      console.log(
        c.dim('\n  api first — its preDeployCommand runs the migrations everything else needs.'),
      );
    }
    if (!behind.length && !failed.length) {
      console.log(c.green('\nEverything running is what is merged.\n'));
    }
  }

  process.exit(behind.length || failed.length ? 1 : 0);
}

main().catch((err) => {
  console.error(c.red(`verify-deployed failed: ${err.message}`));
  process.exit(1);
});
