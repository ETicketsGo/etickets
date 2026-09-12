import {
  MAX_AUTHORISATION_WINDOW_MS,
  destructiveAuthorisationUntil,
  destructiveAuthorisationVerdict,
} from '../../prisma/destructive-authorisation';

/**
 * The authorisation to empty a database expires.
 *
 * ── THE FAILURE ────────────────────────────────────────────────────────────────────
 * The db-seed service runs nightly on a cron schedule with whatever variables it holds. A manual
 * reset whose cleanup was interrupted leaves `SEED_OPERATION=full-reset` and the authorisation
 * behind, and a bare `SEED_ALLOW_DESTRUCTIVE=yes` never stops meaning yes: QA would be emptied
 * every night, and each run's "recovery point" of the empty database would prune a real one.
 *
 * Pure-function tests, like the environment guard's: the verdict takes a value and a clock and
 * touches nothing, so it is decided before any client exists.
 */
const NOW = new Date('2026-09-12T02:00:00.000Z');
const minutes = (n: number) => n * 60_000;
const at = (offsetMs: number) => `yes-until-${new Date(NOW.getTime() + offsetMs).toISOString()}`;

describe('an authorisation that is still current', () => {
  it('is accepted within the next hour', () => {
    expect(destructiveAuthorisationVerdict(at(minutes(45)), NOW).allowed).toBe(true);
    expect(destructiveAuthorisationVerdict(at(MAX_AUTHORISATION_WINDOW_MS), NOW).allowed).toBe(
      true,
    );
  });

  it('accepts exactly the form the Railway runner writes', () => {
    // scripts/deploy/run-seed-operation.mjs builds `yes-until-${new Date(...).toISOString()}`.
    const written = destructiveAuthorisationUntil(NOW, minutes(45));
    expect(written).toBe('yes-until-2026-09-12T02:45:00.000Z');
    expect(destructiveAuthorisationVerdict(written, NOW).allowed).toBe(true);
  });

  it('accepts an explicit offset and is forgiving about case, since a person may type it', () => {
    expect(
      destructiveAuthorisationVerdict('YES-UNTIL-2026-09-12T08:00:00+05:30', NOW).allowed,
    ).toBe(true);
  });
});

describe('what a leftover or careless value can no longer do', () => {
  it('refuses a bare "yes", which never expires', () => {
    const v = destructiveAuthorisationVerdict('yes', NOW);
    expect(v.allowed).toBe(false);
    expect(v.reason).toMatch(/never expires/);
  });

  it('refuses an authorisation left over from an earlier run', () => {
    // The nightly run, hours after a manual reset whose cleanup failed.
    const v = destructiveAuthorisationVerdict(at(-minutes(5)), NOW);
    expect(v.allowed).toBe(false);
    expect(v.reason).toMatch(/expired/);
    expect(destructiveAuthorisationVerdict(at(0), NOW).allowed).toBe(false);
  });

  it('refuses an expiry more than an hour ahead, which is "yes" with extra typing', () => {
    expect(
      destructiveAuthorisationVerdict(at(MAX_AUTHORISATION_WINDOW_MS + 1_000), NOW).allowed,
    ).toBe(false);
    expect(destructiveAuthorisationVerdict('yes-until-2099-01-01T00:00:00Z', NOW).reason).toMatch(
      /more than 60 minutes/,
    );
  });

  it.each([
    'yes-until-tomorrow',
    'yes-until-2026-09-12',
    // No zone: read in the container's local time, which is not a guess to make here.
    'yes-until-2026-09-12T02:30:00',
    'yes-until-',
    'yes-until-2026-02-31T02:30:00Z',
  ])('refuses an expiry it cannot read unambiguously: %s', (value) => {
    expect(destructiveAuthorisationVerdict(value, NOW).allowed).toBe(false);
  });

  it.each([undefined, '', '   '])('refuses when it is not set (%p)', (value) => {
    expect(destructiveAuthorisationVerdict(value, NOW).allowed).toBe(false);
  });
});
