/**
 * The QA suites point at the DEPLOYED environment, not at a local stack.
 *
 * ── WHY THEY MUST NOT RUN BY DEFAULT ───────────────────────────────────────────────
 * They exist to check the one thing local runs and CI cannot: that the build which
 * actually reached QA behaves the way the branch says it should. Two defects in this
 * project's history were only ever visible there.
 *
 * That value depends entirely on running them AFTER a deploy. Left in the default suite
 * they do the opposite of their job: a pull request that changes the UI fails CI because
 * QA has not received the change yet — the branch is red for being ahead of a deployment,
 * which tells nobody anything and trains people to ignore the result.
 *
 * So they are opt-in. `QA_VALIDATE=1 npx playwright test tests/qa-*.spec.ts` after a
 * deploy, which is the moment they are worth anything.
 */
export const QA_VALIDATE = process.env.QA_VALIDATE === '1';

export const QA_SKIP_REASON =
  'QA suite: set QA_VALIDATE=1 and run it against a deployed QA environment.';
