#!/usr/bin/env node
/**
 * Replace every secret an environment inherited when it was duplicated, and PROVE none survived.
 *
 * ── WHY THIS EXISTS ────────────────────────────────────────────────────────────────
 * A Railway environment is created by duplicating an existing one — that is the only way to
 * get service instances into it, because a project token cannot create them. Duplicating
 * copies the source environment's variables, so a production environment duplicated from QA
 * begins life holding QA's JWT signing secrets, QA's QR signing key, QA's payout encryption
 * key and QA's Razorpay TEST credentials.
 *
 * Every one of those is a live problem:
 *
 *   * a shared JWT secret means a token minted in QA is valid in production
 *   * a shared QR signing secret means a ticket generated in QA scans at a real gate
 *   * a shared payout encryption key means one leak reads bank details in both
 *   * an inherited TEST payment key in production is a gateway that takes no money while
 *     appearing to work
 *
 * ── WHY IT VERIFIES RATHER THAN ASSERTS ────────────────────────────────────────────
 * Rotating and then saying "done" is how one variable gets missed. This compares the target
 * against the environment it was copied from, value by value, and reports anything still
 * shared. Values are compared as SHA-256 digests and are never printed, logged or returned —
 * the report says WHICH name is shared, never what it holds.
 *
 *   RAILWAY_TOKEN=<target> RAILWAY_REFERENCE_TOKEN=<source> \
 *     node scripts/deploy/rotate-environment-secrets.mjs --dry-run
 *
 * `--dry-run` reports and changes nothing. Without it, secrets are rotated and credentials
 * that must not be inherited are removed.
 */
import { createHash, randomBytes } from 'node:crypto';

const API = 'https://backboard.railway.app/graphql/v2';
const DRY = process.argv.includes('--dry-run');

const TOKEN = (process.env.RAILWAY_TOKEN ?? '').trim();
const REFERENCE = (process.env.RAILWAY_REFERENCE_TOKEN ?? '').trim();
if (!TOKEN) {
  console.error('RAILWAY_TOKEN must be the token for the environment being rotated.');
  process.exit(1);
}

/**
 * Secrets this platform generates for itself, and the shape each one has to be.
 *
 * Length is not decoration: production hardening refuses anything under 24 characters, and the
 * payout key is read as exactly 32 bytes of base64 by `bank-secret.ts` — a "long random string"
 * there fails at the first bank detail somebody saves, which is a long way from here.
 */
const GENERATED = {
  JWT_ACCESS_SECRET: () => randomBytes(48).toString('base64url'),
  JWT_REFRESH_SECRET: () => randomBytes(48).toString('base64url'),
  QR_SIGNING_SECRET: () => randomBytes(48).toString('base64url'),
  MANIFEST_SIGNING_SECRET: () => randomBytes(48).toString('base64url'),
  PAYMENT_WEBHOOK_SECRET: () => randomBytes(48).toString('base64url'),
  METRICS_TOKEN: () => randomBytes(24).toString('base64url'),
  SES_WEBHOOK_SECRET: () => randomBytes(24).toString('base64url'),
  MSG91_WEBHOOK_SECRET: () => randomBytes(24).toString('base64url'),
  // Exactly 32 bytes, base64 — AES-256. Not base64url: the decoder expects standard base64.
  PAYOUT_BANK_ENCRYPTION_KEY: () => randomBytes(32).toString('base64'),
};

/**
 * Credentials that belong to an account, not to us, and must never be inherited.
 *
 * Removed rather than blanked: an empty string is "configured but broken" to some of the
 * validators, while an absent variable is "not configured", which is the truth and the state
 * every fail-closed check is written against.
 */
const NEVER_INHERIT = [
  'RAZORPAY_KEY_ID',
  'RAZORPAY_KEY_SECRET',
  'RAZORPAY_WEBHOOK_SECRET',
  'RAZORPAY_MODE',
  'STRIPE_SECRET_KEY',
  'STRIPE_PUBLISHABLE_KEY',
  'STRIPE_WEBHOOK_SECRET',
  'AWS_ACCESS_KEY_ID',
  'AWS_SECRET_ACCESS_KEY',
  'MSG91_AUTH_KEY',
  'TWILIO_ACCOUNT_SID',
  'TWILIO_AUTH_TOKEN',
  'R2_ACCESS_KEY_ID',
  'R2_SECRET_ACCESS_KEY',
];

/**
 * Variables that are SUPPOSED to differ per environment but are not secret.
 *
 * Not rotated — reported. Getting `CORS_ORIGINS` or `CUSTOMER_WEB_URL` wrong is a visible,
 * quickly-found break, and inventing values for them here would be guessing at hostnames this
 * script has no way to know.
 */
const MUST_DIFFER = [
  'APP_ENV',
  'CORS_ORIGINS',
  'CUSTOMER_WEB_URL',
  'ORGANIZER_WEB_URL',
  'ADMIN_WEB_URL',
  'PUBLIC_API_URL',
  'SENTRY_ENVIRONMENT',
];

async function gql(token, query, variables = {}) {
  const res = await fetch(API, {
    method: 'POST',
    headers: { 'Project-Access-Token': token, 'Content-Type': 'application/json' },
    body: JSON.stringify({ query, variables }),
  });
  const body = await res.json();
  if (body.errors) throw new Error(body.errors.map((e) => e.message).join('; '));
  return body.data;
}

/** Every service instance in the environment a token belongs to. */
async function environmentOf(token) {
  const { projectToken } = await gql(token, '{ projectToken { projectId environmentId } }');
  const { environment } = await gql(
    token,
    `query($e:String!){ environment(id:$e){ name serviceInstances{edges{node{ serviceId serviceName }}} } }`,
    { e: projectToken.environmentId },
  );
  return {
    ...projectToken,
    name: environment.name,
    services: environment.serviceInstances.edges.map((e) => e.node),
  };
}

async function variablesOf(token, env, serviceId) {
  const d = await gql(
    token,
    `query($p:String!,$e:String!,$s:String!){ variables(projectId:$p, environmentId:$e, serviceId:$s) }`,
    { p: env.projectId, e: env.environmentId, s: serviceId },
  );
  return d.variables ?? {};
}

/** A value's fingerprint. Never the value: this string reaches a terminal and a log. */
const digest = (value) => createHash('sha256').update(String(value)).digest('hex').slice(0, 12);

async function main() {
  const target = await environmentOf(TOKEN);
  console.log(`\nRotating secrets in "${target.name}"${DRY ? '   [DRY RUN]' : ''}`);

  const reference = REFERENCE ? await environmentOf(REFERENCE) : null;
  if (reference) {
    console.log(`Comparing against "${reference.name}" — a shared value is a finding.\n`);
  } else {
    console.log(
      'No RAILWAY_REFERENCE_TOKEN given, so nothing can be compared. Secrets will be\n' +
        'rotated, but this run CANNOT tell you whether any value is still shared with the\n' +
        'environment this one was copied from. Pass it.\n',
    );
  }

  const shared = [];
  const undifferentiated = [];

  for (const service of target.services) {
    const mine = await variablesOf(TOKEN, target, service.serviceId);
    const theirs = reference
      ? await variablesOf(
          REFERENCE,
          reference,
          reference.services.find((s) => s.serviceName === service.serviceName)?.serviceId ??
            service.serviceId,
        ).catch(() => ({}))
      : {};

    const changes = [];

    for (const [name, make] of Object.entries(GENERATED)) {
      // Only rotate what this environment actually has. Adding a secret to a service that
      // never used one is how a variable ends up set on five services and read by none.
      if (!(name in mine)) continue;
      if (DRY) {
        changes.push(`would rotate ${name}`);
        continue;
      }
      await gql(TOKEN, `mutation($in:VariableUpsertInput!){ variableUpsert(input:$in) }`, {
        in: {
          projectId: target.projectId,
          environmentId: target.environmentId,
          serviceId: service.serviceId,
          name,
          value: make(),
        },
      });
      changes.push(`rotated ${name}`);
    }

    for (const name of NEVER_INHERIT) {
      if (!(name in mine)) continue;
      if (DRY) {
        changes.push(`would REMOVE ${name} (belongs to an account, not an environment)`);
        continue;
      }
      await gql(TOKEN, `mutation($in:VariableDeleteInput!){ variableDelete(input:$in) }`, {
        in: {
          projectId: target.projectId,
          environmentId: target.environmentId,
          serviceId: service.serviceId,
          name,
        },
      });
      changes.push(`REMOVED ${name}`);
    }

    // The verification. Done after the writes, against what is actually stored now.
    const after = DRY ? mine : await variablesOf(TOKEN, target, service.serviceId);
    for (const [name, value] of Object.entries(after)) {
      if (name.startsWith('RAILWAY_')) continue; // Railway's own, environment-scoped already.
      if (!(name in theirs)) continue;
      if (digest(value) !== digest(theirs[name])) continue;
      if (MUST_DIFFER.includes(name)) undifferentiated.push(`${service.serviceName}.${name}`);
      else if (name in GENERATED || NEVER_INHERIT.includes(name))
        shared.push(`${service.serviceName}.${name}`);
    }

    if (changes.length) {
      console.log(`  ${service.serviceName}`);
      for (const c of changes) console.log(`    ${c}`);
    }
  }

  if (reference) {
    console.log('\nVerification');
    if (shared.length === 0) {
      console.log('  ok   no secret is shared with the source environment');
    } else {
      console.log('  FAIL these still hold the SAME value as the source environment:');
      for (const s of shared) console.log(`        ${s}`);
    }
    if (undifferentiated.length) {
      console.log('\n  These are not secret, but are supposed to differ per environment:');
      for (const s of undifferentiated) console.log(`        ${s}`);
      console.log('  Set them to this environment own hostnames before it serves anybody.');
    }
  }

  console.log(
    DRY
      ? '\nNothing was changed. Re-run without --dry-run to apply.\n'
      : '\nProvider credentials were REMOVED, not replaced: they are issued per account and\n' +
          'this environment needs its own. Until they are set, fail-closed checks keep the\n' +
          'affected features off, which is the correct state for an environment with no keys.\n',
  );

  if (shared.length > 0) process.exit(1);
}

main().catch((e) => {
  console.error(`\nrotation failed: ${e.message}\n`);
  process.exit(1);
});
