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
const VALID = ['status', 'india-cinema', 'full-reset'];
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

let deploymentId = null;
try {
  await setVar('SEED_OPERATION', operation);
  if (destructive) await setVar('SEED_ALLOW_DESTRUCTIVE', 'yes');

  const priorId = (await instanceOf())?.latestDeployment?.id ?? null;
  await gql(
    `mutation($e:String!,$s:String!){ serviceInstanceDeploy(environmentId:$e, serviceId:$s, latestCommit:true) }`,
    { e: environmentId, s: serviceId },
  );

  // A one-off job is EXPECTED to exit, and Railway reports that as SUCCESS or CRASHED
  // depending on the exit code. The terminal state is not the result — the logs are.
  const TERMINAL = ['SUCCESS', 'FAILED', 'CRASHED', 'REMOVED'];
  const deadline = Date.now() + 25 * 60 * 1000;
  let status = null;
  while (Date.now() < deadline) {
    const dep = (await instanceOf())?.latestDeployment;
    if (dep && dep.id !== priorId) {
      if (dep.status !== status) console.log(`  ${(status = dep.status)}`);
      deploymentId = dep.id;
      if (TERMINAL.includes(status)) break;
    }
    await sleep(5000);
  }
  if (!deploymentId) throw new Error('No new deployment appeared within the timeout.');
} finally {
  // Always, on every path — an exception, a failed build, a timeout. Leaving SEED_OPERATION
  // set means the next person to redeploy this service runs whatever it still says.
  await deleteVar('SEED_OPERATION');
  await deleteVar('SEED_ALLOW_DESTRUCTIVE');
  console.log('  variables cleared (service returns to the read-only default)');
}

console.log('\n──────── output ────────');
const { deploymentLogs } = await gql(
  `query($id:String!){ deploymentLogs(deploymentId:$id, limit:500){ message } }`,
  { id: deploymentId },
);
for (const l of deploymentLogs) console.log(l.message);
