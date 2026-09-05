/**
 * Run one database operation inside the Railway private network, via the `db-seed` service.
 *
 * ── WHY THIS EXISTS ────────────────────────────────────────────────────────────────
 * QA's Postgres has no public proxy, which is correct, so regulatory seed data cannot be
 * written from a developer machine. `railway ssh` needs an account SSH key. The remaining
 * honest route is the service that exists to run database commands.
 *
 * ── WHY IT SETS A VARIABLE AND NOT A START COMMAND ─────────────────────────────────
 * The first version of this script set `startCommand` through the Railway API, deployed, and
 * restored it afterwards. The API accepted the change and read it back correctly — and the
 * deployment ran the old command anyway, because `deploy/railway/db-seed.railway.json` is
 * config-as-code and silently wins. The old command was the destructive seed. QA was emptied.
 *
 * Environment variables are not overridden by config-as-code, so the service always runs the
 * same dispatcher and a variable selects the work. With no variable set the dispatcher does a
 * read-only census, which means a stray redeploy reports rather than destroys.
 *
 *   node scripts/deploy/run-seed-operation.mjs status
 *   node scripts/deploy/run-seed-operation.mjs india-cinema
 *   node scripts/deploy/run-seed-operation.mjs full-reset --yes-empty-the-database
 */
const TOKEN = process.env.RAILWAY_TOKEN;
if (!TOKEN) throw new Error('RAILWAY_TOKEN is not set.');

const operation = process.argv[2];
const VALID = [
  'status',
  'backups',
  'backup',
  'restore-drill',
  'india-gst',
  'india-gst-activate',
  'india-cinema',
  'full-reset',
];
if (!VALID.includes(operation)) {
  throw new Error(`Pass one of: ${VALID.join(', ')}`);
}
const destructive = operation === 'full-reset';
if (destructive && !process.argv.includes('--yes-empty-the-database')) {
  throw new Error(
    'full-reset empties every table in the target database. Re-run with --yes-empty-the-database.',
  );
}

const gql = async (query, variables) => {
  const r = await fetch('https://backboard.railway.app/graphql/v2', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Project-Access-Token': TOKEN },
    body: JSON.stringify({ query, variables }),
  });
  const j = await r.json();
  if (j.errors) throw new Error(JSON.stringify(j.errors).slice(0, 500));
  return j.data;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const {
  projectToken: { projectId, environmentId },
} = await gql('{ projectToken { projectId environmentId } }');
const { project } = await gql(
  `query($id:String!){ project(id:$id){ name services{edges{node{id name}}} } }`,
  { id: projectId },
);
const svc = project.services.edges.find((e) => e.node.name === 'db-seed');
if (!svc) throw new Error('No `db-seed` service in this environment.');
const serviceId = svc.node.id;

// The project token is scoped to one environment, so it cannot reach production — but say
// out loud which one is about to be written to, because "which environment" is exactly the
// thing people get wrong.
const { environment } = await gql(`query($id:String!){ environment(id:$id){ name } }`, {
  id: environmentId,
}).catch(() => ({ environment: { name: environmentId } }));
console.log(`project ${project.name} · environment ${environment.name} · operation ${operation}`);

const setVar = (name, value) =>
  gql(
    `mutation($i:VariableUpsertInput!){ variableUpsert(input:$i) }`,
    { i: { projectId, environmentId, serviceId, name, value } },
  );
const deleteVar = (name) =>
  gql(`mutation($i:VariableDeleteInput!){ variableDelete(input:$i) }`, {
    i: { projectId, environmentId, serviceId, name },
  }).catch(() => null);

const instanceQuery = `query($id:String!){ service(id:$id){ serviceInstances{edges{node{ environmentId latestDeployment{ id status } }}} } }`;
const instanceOf = async () => {
  const d = await gql(instanceQuery, { id: serviceId });
  return d.service.serviceInstances.edges
    .map((e) => e.node)
    .find((n) => n.environmentId === environmentId);
};

/**
 * ── WHY THIS IS SO CAREFUL ABOUT WHEN VARIABLES ARE SET ────────────────────────────
 * Railway redeploys a service when its variables change. Setting two variables and then
 * triggering a deploy therefore produced THREE deployments inside the same second — and for a
 * full reset, more than one of them ran. A reset executing concurrently with its own reseed
 * leaves a half-seeded database: observed on QA as fee rules and payment configuration present
 * with no users, events or bookings, from a run whose own logs said "Seed complete".
 *
 * So the ordering is deliberate:
 *   1. clear stale variables, and let the induced deployments settle
 *   2. set the AUTHORISATION first — a deployment induced here sees no operation and does
 *      nothing, which is exactly what should happen
 *   3. set the OPERATION last, so the deployment it induces is the one that does the work
 *   4. ADOPT that deployment instead of triggering another
 *   5. touch nothing until it reaches a terminal state
 *
 * Clearing the variables afterwards induces one more deployment. That one runs the read-only
 * default, which is the entire reason the default is read-only.
 */
const latestDeployment = async () => (await instanceOf())?.latestDeployment ?? null;
const TICK = 5000;

/** Wait until no NEW deployment has appeared for `quietMs`, so induced redeploys settle. */
async function settle(quietMs = 25000) {
  let last = (await latestDeployment())?.id ?? null;
  let quietSince = Date.now();
  while (Date.now() - quietSince < quietMs) {
    await sleep(TICK);
    const now = (await latestDeployment())?.id ?? null;
    if (now !== last) {
      last = now;
      quietSince = Date.now();
    }
  }
  return last;
}

let deploymentId = null;
try {
  // 1. Start from a known state. A stale SEED_OPERATION is an instruction nobody gave.
  await deleteVar('SEED_OPERATION');
  await deleteVar('SEED_ALLOW_DESTRUCTIVE');
  console.log('  settling after clearing stale variables...');
  const priorId = await settle();

  // 2. Authorisation first. Anything induced now has no operation to perform.
  if (destructive) await setVar('SEED_ALLOW_DESTRUCTIVE', 'yes');

  // 3. The operation last. The deployment this induces is the run.
  await setVar('SEED_OPERATION', operation);

  // 4. Adopt what that induced, rather than adding a deployment of our own.
  const deadline = Date.now() + 25 * 60 * 1000;
  let status = null;
  let adopted = null;
  let triggered = false;
  while (Date.now() < deadline) {
    const dep = await latestDeployment();
    if (dep && dep.id !== priorId) {
      if (!adopted) {
        adopted = dep.id;
        console.log(`  adopted deployment ${dep.id.slice(0, 8)}`);
      }
      if (dep.id !== adopted) {
        // A superseded run may have executed part way before being killed, so say so loudly
        // rather than quietly following the newer one.
        console.log(`  superseded by ${dep.id.slice(0, 8)} — following that instead`);
        adopted = dep.id;
        status = null;
      }
      if (dep.status !== status) console.log(`  ${(status = dep.status)}`);
      deploymentId = adopted;
      /*
        REMOVED is not "finished". It means Railway KILLED this deployment, almost always
        because another superseded it — and a container killed part way through has done some
        unknown fraction of its work.

        Treating it as terminal is how two GST runs reported a clean finish and wrote nothing:
        the deployment was removed, the loop exited, the variables were cleared, and the
        operation never ran. Wait for a real outcome instead, and let the supersede branch
        above follow whichever deployment actually gets to run.
      */
      if (status === 'REMOVED') {
        console.log('  (removed — superseded before it finished; waiting for the live one)');
        adopted = null;
        status = null;
        deploymentId = null;
      } else if (['SUCCESS', 'FAILED', 'CRASHED'].includes(status)) {
        break;
      }
    } else if (!triggered && Date.now() > deadline - 24 * 60 * 1000) {
      triggered = true;
      console.log('  nothing induced; triggering exactly one deployment');
      await gql(
        `mutation($e:String!,$s:String!){ serviceInstanceDeploy(environmentId:$e, serviceId:$s, latestCommit:true) }`,
        { e: environmentId, s: serviceId },
      );
    }
    await sleep(TICK);
  }
  if (!deploymentId) throw new Error('No deployment reached a terminal state within the timeout.');
  if (status !== 'SUCCESS') {
    console.error(`
!! the run ended ${status}, so the operation may not have completed.`);
    process.exitCode = 1;
  }
} finally {
  // 5. Always, on every path. A left-behind SEED_OPERATION is what the next person's redeploy
  //    would run. Clearing induces one more deployment, which runs the read-only default.
  await deleteVar('SEED_OPERATION');
  await deleteVar('SEED_ALLOW_DESTRUCTIVE');
  console.log('  variables cleared (service returns to the read-only default)');
}


/*
  Logs lag the deployment's terminal state, and a one-shot job can finish before any are
  queryable — which produced an empty "output" section indistinguishable from a run that did
  nothing at all. Poll rather than reporting silence as a result.

  Even then the API returns lines UNORDERED and sometimes incompletely, which is why each
  operation prints a single-line JSON summary (CENSUS_JSON / BACKUP_JSON / RESTORE_DRILL_JSON)
  next to its human-readable output: one line either arrives whole or does not arrive.
*/
console.log('\n──────── output ────────');
let logs = [];
for (let attempt = 0; attempt < 12 && logs.length === 0; attempt++) {
  if (attempt) await sleep(5000);
  ({ deploymentLogs: logs } = await gql(
    `query($id:String!){ deploymentLogs(deploymentId:$id, limit:500){ message } }`,
    { id: deploymentId },
  ));
}
if (logs.length === 0) {
  console.log(
    `(Railway served no logs for deployment ${deploymentId}. It reached a terminal state — the ` +
      'output simply was not returned. Re-run, or read it in the Railway dashboard.)',
  );
}
for (const l of logs) console.log(l.message);
