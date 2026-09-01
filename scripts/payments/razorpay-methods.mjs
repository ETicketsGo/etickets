#!/usr/bin/env node
/**
 * What can this Razorpay account ACTUALLY take a payment with?
 *
 * ── WHY THIS EXISTS ────────────────────────────────────────────────────────────────
 * The test walkthrough in this repo told people to pay with card `4111 1111 1111 1111`
 * and the UPI VPA `success@razorpay`. Both came from Razorpay's generic documentation,
 * and neither works on the QA account: Checkout answered "International cards are not
 * supported", and UPI is not enabled on the account at all.
 *
 * That is not a Razorpay bug and it is not a code bug — the enabled payment methods are a
 * per-account setting, and a documentation page cannot know what any particular merchant
 * has switched on. Writing them down from the docs guaranteed the instructions would be
 * wrong for somebody.
 *
 * So: ask the account. `/v1/preferences` is the same public preflight Checkout itself
 * calls before drawing its method list, so what this prints is exactly what the buyer will
 * be offered — no guessing, and it stays right when the account changes.
 *
 * Usage:
 *   RAZORPAY_KEY_ID=rzp_test_... node scripts/payments/razorpay-methods.mjs
 *   RAILWAY_TOKEN=<qa token>    node scripts/payments/razorpay-methods.mjs   # reads QA's key
 *
 * Only the PUBLIC key id is used. The secret is never needed here and is never read.
 */

const RAILWAY = 'https://backboard.railway.app/graphql/v2';

async function gql(query, variables = {}, attempt = 1) {
  const res = await fetch(RAILWAY, {
    method: 'POST',
    headers: {
      'Project-Access-Token': process.env.RAILWAY_TOKEN,
      'Content-Type': 'application/json',
    },
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

/** The key id from the environment, or from the deployed api service if only a token is set. */
async function resolveKeyId() {
  if (process.env.RAZORPAY_KEY_ID) return process.env.RAZORPAY_KEY_ID;
  if (!process.env.RAILWAY_TOKEN) {
    throw new Error('Set RAZORPAY_KEY_ID, or RAILWAY_TOKEN to read it from the environment.');
  }
  const {
    projectToken: { projectId, environmentId },
  } = await gql('{ projectToken { projectId environmentId } }');
  const { project } = await gql(
    `query($id:String!){project(id:$id){services{edges{node{id name}}}}}`,
    { id: projectId },
  );
  const api = project.services.edges.find((e) => e.node.name === 'api')?.node;
  if (!api) throw new Error('No `api` service in this environment.');
  const { variables } = await gql(
    `query($p:String!,$e:String!,$s:String!){variables(projectId:$p,environmentId:$e,serviceId:$s)}`,
    { p: projectId, e: environmentId, s: api.id },
  );
  const key = variables.RAZORPAY_KEY_ID;
  if (!key) throw new Error('RAZORPAY_KEY_ID is not set on this environment.');
  return key;
}

const on = (v) => (v ? '\x1b[32myes\x1b[0m' : '\x1b[31mno \x1b[0m');

async function main() {
  const keyId = await resolveKeyId();
  // Mode, not the key: a key id in a terminal ends up in a screenshot or a scrollback.
  console.log(`\nRazorpay account: ${keyId.startsWith('rzp_test_') ? 'TEST mode' : 'LIVE MODE'}\n`);
  if (!keyId.startsWith('rzp_test_')) {
    console.log('\x1b[33mThis is a LIVE key. Do not run test payments against it.\x1b[0m\n');
  }

  const res = await fetch(
    `https://api.razorpay.com/v1/preferences?key_id=${encodeURIComponent(keyId)}&currency=INR`,
  );
  if (!res.ok) throw new Error(`preferences returned HTTP ${res.status}`);
  const methods = (await res.json()).methods ?? {};

  const banks = Object.keys(methods.netbanking ?? {}).length;
  const wallets = Object.entries(methods.wallet ?? {})
    .filter(([, enabled]) => enabled)
    .map(([name]) => name);
  const networks = Object.entries(methods.card_networks ?? {})
    .filter(([, enabled]) => enabled)
    .map(([name]) => name);

  console.log('  method       enabled  detail');
  console.log(`  card         ${on(methods.card)}      networks: ${networks.join(', ') || '—'}`);
  console.log(`  upi          ${on(methods.upi)}`);
  console.log(`  netbanking   ${on(banks > 0)}      ${banks} banks`);
  console.log(`  wallet       ${on(wallets.length)}      ${wallets.join(', ') || '—'}`);
  console.log(`  emi          ${on(methods.emi)}`);

  console.log('\nWhat to test with, on THIS account:');
  if (banks > 0) console.log('  • Netbanking — pick any bank, then press Success on their page.');
  if (wallets.length) console.log(`  • Wallet — ${wallets[0]}, then press Success.`);
  if (methods.upi) console.log('  • UPI — the test VPA from the Razorpay dashboard.');
  if (!methods.upi) {
    console.log(
      '  • UPI is OFF. Enable it in Razorpay Dashboard → Settings → Configuration →\n' +
        '    Payment Methods before telling anyone to test with a UPI id.',
    );
  }
  console.log(
    '  • Cards: test numbers are account-specific and are listed in the Razorpay\n' +
      '    dashboard itself. A generic number from the docs may be treated as\n' +
      '    INTERNATIONAL, which is disabled by default and fails with\n' +
      '    "International cards are not supported".',
  );
  console.log(
    '\nThis reflects the account right now — it is the same preflight Checkout calls, so\n' +
      'what is listed above is what the buyer will actually be offered.\n',
  );
}

main().catch((err) => {
  console.error(`\x1b[31m${err.message}\x1b[0m`);
  process.exit(1);
});
