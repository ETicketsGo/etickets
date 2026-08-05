#!/usr/bin/env node
/**
 * Deploy one Railway service and block until the deployment reaches a terminal state.
 *
 * Replaces `railway up --ci` in the CD pipeline. That command streams build logs and exits
 * non-zero if the stream drops — which it does:
 *
 *   Failed to stream build logs: Failed to retrieve build log
 *   ##[error]Process completed with exit code 1
 *
 * The deployment was still BUILDING at that moment and went on to complete. So the pipeline
 * reported a failure that had not happened, and — much worse — abandoned the sequence while
 * Railway carried on rolling the service. The readiness gate never ran, the worker and web
 * tier never deployed, and the api changed underneath all of it. A transport hiccup in a log
 * stream must not be able to produce a partially-deployed environment.
 *
 * This polls the deployment's actual status instead, so the exit code reflects what Railway
 * did rather than whether a websocket stayed up.
 *
 * Auth: RAILWAY_TOKEN (a project-scoped token) — the same secret the pipeline already holds.
 *
 * Usage:
 *   RAILWAY_TOKEN=... node scripts/deploy/railway-deploy-and-wait.mjs <service-name> [timeoutSeconds]
 *
 * Exit 0 only when the deployment reaches SUCCESS or SLEEPING (a service with app-sleeping
 * enabled may go straight to sleep after a healthy start — that is a success, not a failure).
 */

const API = 'https://backboard.railway.app/graphql/v2';
const TOKEN = process.env.RAILWAY_TOKEN;
const SERVICE = process.argv[2];
const TIMEOUT_S = Number(process.argv[3] ?? 900);

if (!TOKEN) {
  console.error('RAILWAY_TOKEN is not set.');
  process.exit(1);
}
if (!SERVICE) {
  console.error('Usage: railway-deploy-and-wait.mjs <service-name> [timeoutSeconds]');
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

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Terminal states. SLEEPING counts as success — app-sleeping services reach it after a healthy start. */
const OK = new Set(['SUCCESS', 'SLEEPING']);
const BAD = new Set(['FAILED', 'CRASHED', 'REMOVED']);

async function main() {
  const { projectToken } = await gql('{ projectToken { projectId environmentId } }');
  const { projectId, environmentId } = projectToken;

  const { project } = await gql(
    `query($id:String!){ project(id:$id){ name services{edges{node{id name}}} } }`,
    { id: projectId },
  );
  const svc = project.services.edges.find((e) => e.node.name === SERVICE);
  if (!svc) {
    console.error(
      `Service "${SERVICE}" not found in project "${project.name}". ` +
        `Present: ${project.services.edges.map((e) => e.node.name).join(', ')}`,
    );
    process.exit(1);
  }
  const serviceId = svc.node.id;

  /** Read the current terminal-or-not status for this service in this environment. */
  const status = async () => {
    const d = await gql(
      `query($id:String!){ service(id:$id){ serviceInstances{edges{node{ environmentId latestDeployment{ id status } }}} } }`,
      { id: serviceId },
    );
    const inst = d.service.serviceInstances.edges.find(
      (e) => e.node.environmentId === environmentId,
    );
    return inst?.node.latestDeployment ?? null;
  };

  const before = await status();
  console.log(`Deploying "${SERVICE}" (was: ${before?.status ?? 'none'})`);

  await gql(
    `mutation($e:String!,$s:String!){ serviceInstanceDeploy(environmentId:$e, serviceId:$s, latestCommit:true) }`,
    { e: environmentId, s: serviceId },
  );

  const deadline = Date.now() + TIMEOUT_S * 1000;
  let last = '';
  while (Date.now() < deadline) {
    await sleep(10_000);
    let cur;
    try {
      cur = await status();
    } catch (err) {
      // A transient API error must not fail the deploy — that is the bug being fixed.
      console.log(`  (status check failed, retrying: ${err.message})`);
      continue;
    }
    if (!cur) continue;

    // Ignore the previous deployment still showing until the new one is registered.
    if (before?.id && cur.id === before.id) continue;

    if (cur.status !== last) {
      console.log(`  ${cur.status}`);
      last = cur.status;
    }
    if (OK.has(cur.status)) {
      console.log(`"${SERVICE}" deployed (${cur.status}).`);
      return;
    }
    if (BAD.has(cur.status)) {
      console.error(
        `::error::"${SERVICE}" deployment ended ${cur.status}. ` +
          `Logs: https://railway.com/project/${projectId}/service/${serviceId}?id=${cur.id}`,
      );
      process.exit(1);
    }
  }

  console.error(`::error::"${SERVICE}" did not reach a terminal state within ${TIMEOUT_S}s.`);
  process.exit(1);
}

main().catch((e) => {
  console.error(`::error::deploy failed: ${e.message}`);
  process.exit(1);
});
