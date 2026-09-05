/**
 * Is this environment safe from the accident that emptied QA?
 *
 * ── WHAT THIS ANSWERS ──────────────────────────────────────────────────────────────
 * The offline gate (`npm run verify:deploy`) proves the REPOSITORY is safe. It cannot see
 * what a live environment is actually configured to do — which start command a service really
 * has, whether the database is exposed to the internet, whether a single backup exists. Those
 * are properties of the deployment, and the incident was a deployment property: an API-set
 * start command that config-as-code silently overrode.
 *
 * Run it against every environment, and against production first.
 *
 *   RAILWAY_TOKEN=<environment token> node scripts/ops/database-safety-audit.mjs
 *
 * It reads. It changes nothing, and it prints no credential.
 */
const TOKEN = process.env.RAILWAY_TOKEN;
if (!TOKEN) throw new Error('RAILWAY_TOKEN is not set.');

const gql = async (query, variables) => {
  const r = await fetch('https://backboard.railway.app/graphql/v2', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Project-Access-Token': TOKEN },
    body: JSON.stringify({ query, variables }),
  });
  const j = await r.json();
  if (j.errors) throw new Error(JSON.stringify(j.errors).slice(0, 300));
  return j.data;
};

const results = [];
const ok = (name, detail) => results.push({ level: 'PASS', name, detail });
const bad = (name, detail) => results.push({ level: 'FAIL', name, detail });
const note = (name, detail) => results.push({ level: 'WARN', name, detail });

const {
  projectToken: { projectId, environmentId },
} = await gql('{ projectToken { projectId environmentId } }');
const { environment } = await gql(`query($id:String!){ environment(id:$id){ name } }`, {
  id: environmentId,
}).catch(() => ({ environment: { name: environmentId } }));
const { project } = await gql(
  `query($id:String!){ project(id:$id){ name services{edges{node{id name}}} volumes{edges{node{ id name volumeInstances{edges{node{ id environmentId serviceId }}} }}} } }`,
  { id: projectId },
);

console.log(`\nDATABASE SAFETY AUDIT — ${project.name} / ${environment.name}\n`);

const services = project.services.edges.map((e) => e.node);
const varsFor = async (serviceId) =>
  (
    await gql(
      `query($p:String!,$e:String!,$s:String!){ variables(projectId:$p, environmentId:$e, serviceId:$s) }`,
      { p: projectId, e: environmentId, s: serviceId },
    )
  ).variables;

const instanceFor = async (serviceId) => {
  const d = await gql(
    `query($id:String!){ service(id:$id){ serviceInstances{edges{node{ environmentId startCommand railwayConfigFile restartPolicyType }}} } }`,
    { id: serviceId },
  );
  return d.service.serviceInstances.edges
    .map((e) => e.node)
    .find((n) => n.environmentId === environmentId);
};

/* ── 1. Can every service tell which environment it is in? ───────────────────────── */
const RESETTABLE = ['LOCAL', 'DEV', 'TEST', 'CI', 'QA', 'UAT'];
for (const svc of services.filter((s) => ['api', 'worker', 'db-seed'].includes(s.name))) {
  const v = await varsFor(svc.id);
  const appEnv = (v.APP_ENV ?? '').trim().toUpperCase();
  if (!appEnv) {
    // The guard refuses when it cannot identify the environment, so this is safe-but-broken:
    // nothing destructive can run, including the things that legitimately should.
    bad(`${svc.name}: APP_ENV`, 'not set — the destructive guard cannot identify this environment');
  } else {
    ok(`${svc.name}: APP_ENV`, appEnv);
  }
}

/* ── 2. Is the database reachable from the public internet? ──────────────────────── */
const pg = services.find((s) => /postgres/i.test(s.name));
if (pg) {
  const v = await varsFor(pg.id);
  const publicUrl = Object.keys(v).find((k) => /PUBLIC_URL/.test(k) && /DATABASE|PG/i.test(k));
  if (publicUrl) {
    bad(
      'Postgres exposure',
      `${publicUrl} is set — the database has a public TCP proxy and is reachable from outside the private network`,
    );
  } else {
    ok('Postgres exposure', 'no public proxy; private network only');
  }
}

/* ── 3. The seed service: what would deploying it actually DO? ───────────────────── */
const seed = services.find((s) => s.name === 'db-seed');
if (!seed) {
  note('db-seed', 'no seed service in this environment (nothing to misfire)');
} else {
  const inst = await instanceFor(seed.id);
  if (inst?.railwayConfigFile) {
    ok('db-seed: config-as-code', `${inst.railwayConfigFile} (authoritative; overrides the API)`);
  } else {
    note(
      'db-seed: config-as-code',
      'no config path set — the service falls back to the root railway.json, which describes the API',
    );
  }
  /*
    The API-level start command does not decide what runs when config-as-code is present — but
    it is what a person reads in the dashboard, and what WOULD apply if the config file were
    removed. QA held `npm run db:seed` here, the destructive value, while running the safe one.
  */
  const cmd = inst?.startCommand ?? '';
  if (/prisma\/seed\.ts|npm run db:seed\b/.test(cmd)) {
    bad(
      'db-seed: dashboard start command',
      'still names the destructive seed; harmless while config-as-code wins, and the value that applies if it is ever removed',
    );
  } else {
    ok('db-seed: dashboard start command', cmd ? 'the dispatcher' : '(unset)');
  }
  if (inst?.restartPolicyType === 'NEVER') {
    ok('db-seed: restart policy', 'NEVER — a one-shot job cannot loop');
  } else {
    bad('db-seed: restart policy', `${inst?.restartPolicyType} — a destructive job that restarts repeats itself`);
  }

  const v = await varsFor(seed.id);
  const left = Object.keys(v).filter((k) => k.startsWith('SEED_'));
  if (left.length) {
    bad(
      'db-seed: leftover authorisation',
      `${left.join(', ')} still set — the next redeploy of this service would act on them`,
    );
  } else {
    ok('db-seed: leftover authorisation', 'none; the service returns to its read-only default');
  }
}

/* ── 4. Backups ──────────────────────────────────────────────────────────────────── */
const pgVolume = project.volumes.edges
  .map((e) => e.node)
  .find((v) => v.volumeInstances.edges.some((i) => i.node.serviceId === pg?.id));
const pgInstance = pgVolume?.volumeInstances.edges
  .map((e) => e.node)
  .find((i) => i.environmentId === environmentId);

if (!pgInstance) {
  note('Railway backups', 'no Postgres volume found in this environment');
} else {
  const [backups, schedules] = await Promise.all([
    gql(`query($id:String!){ volumeInstanceBackupList(volumeInstanceId:$id){ id createdAt } }`, {
      id: pgInstance.id,
    }).then((d) => d.volumeInstanceBackupList),
    gql(
      `query($id:String!){ volumeInstanceBackupScheduleList(volumeInstanceId:$id){ id kind retentionSeconds } }`,
      { id: pgInstance.id },
    ).then((d) => d.volumeInstanceBackupScheduleList),
  ]);
  if (schedules.length === 0) {
    bad(
      'Railway backup schedule',
      'NONE. Enable daily backups on the Postgres volume in the Railway dashboard — a project token cannot do it (volumeInstanceBackupScheduleUpdate returns Not Authorized)',
    );
  } else {
    ok('Railway backup schedule', schedules.map((s) => s.kind).join(', '));
  }
  if (backups.length === 0) {
    bad('Railway backups', 'ZERO snapshots exist for this database');
  } else {
    const newest = backups.map((b) => new Date(b.createdAt)).sort((a, b) => b - a)[0];
    const ageH = ((Date.now() - newest.getTime()) / 3_600_000).toFixed(1);
    ok('Railway backups', `${backups.length}, newest ${ageH}h old`);
  }

  // Our own pg_dump recovery points live on a volume mounted at /backups on db-seed. Whether
  // any exist can only be read from inside; say so rather than implying it was checked.
  const seedVolume = project.volumes.edges
    .map((e) => e.node)
    .find((v) => v.volumeInstances.edges.some((i) => i.node.serviceId === seed?.id));
  if (seed && !seedVolume) {
    bad(
      'pg_dump recovery points',
      'db-seed has no volume, so the platform cannot take or keep its own backups',
    );
  } else if (seed) {
    note(
      'pg_dump recovery points',
      'volume present; run `node scripts/deploy/run-seed-operation.mjs backups` to list them (only readable from inside the network)',
    );
  }
}

/* ── report ──────────────────────────────────────────────────────────────────────── */
const width = Math.max(...results.map((r) => r.name.length));
for (const r of results) {
  const tag = r.level === 'PASS' ? ' ok ' : r.level === 'FAIL' ? 'FAIL' : 'note';
  console.log(`  [${tag}] ${r.name.padEnd(width)}  ${r.detail}`);
}
const failed = results.filter((r) => r.level === 'FAIL');
console.log(
  `\n${failed.length === 0 ? 'No safety failures.' : `${failed.length} safety failure(s).`}\n`,
);
process.exitCode = failed.length === 0 ? 0 : 1;
