import {
  DEFAULTABLE,
  OPERATION_WINDOW_VARIABLE,
  evidenceLine,
  resolveOperation,
} from '../../prisma/scheduled-operation';

/**
 * unit - the nightly backup cannot be silently replaced by something else.
 *
 * ── THE INCIDENT THESE COME FROM ───────────────────────────────────────────────────
 * Production went five days with no backup. A manual `payment-providers` run left
 * `SEED_OPERATION` behind; an explicit operation outranks the `SEED_DEFAULT_OPERATION=backup`
 * fallback, so every 02:00 run re-asserted payment rows and took no recovery point - and each
 * one was a green scheduled deployment. It surfaced only because somebody went looking for a
 * dump at a pre-deploy gate and found the newest was five days old.
 *
 * The lesson is not "clear your variables". It is that a schedule running the WRONG job looks
 * exactly like one running the right job, because both end in SUCCESS. These tests hold the
 * two properties that make the difference: the scheduled run resolves to `backup`, and a stale
 * override is refused rather than obeyed.
 */

/** 45 minutes ahead - what the runner writes. */
const until = (ms: number) => new Date(Date.now() + ms).toISOString();
const NOW = new Date('2026-10-05T02:00:00.000Z');

describe('the scheduled run takes a backup', () => {
  it('resolves to backup when nothing is pinned', () => {
    const v = resolveOperation({ SEED_DEFAULT_OPERATION: 'backup' }, NOW);
    expect(v.operation).toBe('backup');
    expect(v.source).toBe('scheduled');
    expect(v.allowed).toBe(true);
  });

  it('treats a blanked SEED_OPERATION as unset, not as an unknown operation', () => {
    // Clearing a Railway variable can leave an empty string behind rather than removing it.
    const v = resolveOperation({ SEED_OPERATION: '   ', SEED_DEFAULT_OPERATION: 'backup' }, NOW);
    expect(v.operation).toBe('backup');
    expect(v.source).toBe('scheduled');
  });

  it('falls back to a read-only census when nothing at all is configured', () => {
    const v = resolveOperation({}, NOW);
    expect(v.operation).toBe('status');
    expect(v.allowed).toBe(true);
  });

  it('never lets a schedule select a writing operation', () => {
    /*
      A schedule that empties a database should be impossible to configure, not merely
      awkward - so the fallback list is checked, not just the destructive flag.
    */
    for (const dangerous of ['full-reset', 'payment-providers', 'india-gst-activate']) {
      const v = resolveOperation({ SEED_DEFAULT_OPERATION: dangerous }, NOW);
      expect(v.operation).toBe('status');
    }
    expect(DEFAULTABLE).toEqual(['status', 'backup', 'backups', 'restore-drill']);
  });
});

describe('a stale override cannot shadow the backup', () => {
  it('refuses the exact configuration that cost us five days of backups', () => {
    const v = resolveOperation(
      { SEED_OPERATION: 'payment-providers', SEED_DEFAULT_OPERATION: 'backup' },
      NOW,
    );
    expect(v.allowed).toBe(false);
    // The message has to reach whoever reads the failed cron, not the person who left it behind.
    expect(v.reason).toContain('payment-providers');
    expect(v.reason).toContain('run-seed-operation.mjs');
  });

  it('refuses an expired authorisation', () => {
    const v = resolveOperation(
      {
        SEED_OPERATION: 'payment-providers',
        [OPERATION_WINDOW_VARIABLE]: '2026-10-04T20:00:00Z',
      },
      NOW,
    );
    expect(v.allowed).toBe(false);
    expect(v.reason).toContain('expired');
  });

  it('refuses an authorisation that is really permanent', () => {
    // `until-2099` is "yes" with extra typing, which is the whole reason for the cap.
    const v = resolveOperation(
      { SEED_OPERATION: 'status', [OPERATION_WINDOW_VARIABLE]: '2099-01-01T00:00:00Z' },
      NOW,
    );
    expect(v.allowed).toBe(false);
  });

  it('refuses an unreadable or zone-less expiry rather than guessing', () => {
    for (const bad of ['yes', 'tomorrow', '2026-10-05', '2026-10-05T02:30:00']) {
      const v = resolveOperation(
        { SEED_OPERATION: 'backup', [OPERATION_WINDOW_VARIABLE]: bad },
        NOW,
      );
      expect(v.allowed).toBe(false);
    }
  });

  it('refuses even a pinned backup, because pinning is the defect', () => {
    /*
      `SEED_OPERATION=backup` looks harmless and is still wrong: the runner clears the variable
      after every manual run, so a pinned value is by definition left over, and the next manual
      operation would silently become the nightly job.
    */
    const v = resolveOperation({ SEED_OPERATION: 'backup', SEED_DEFAULT_OPERATION: 'backup' }, NOW);
    expect(v.allowed).toBe(false);
  });
});

describe('authorised manual maintenance still works', () => {
  it('allows an explicit operation inside its window', () => {
    const v = resolveOperation({
      SEED_OPERATION: 'payment-providers',
      [OPERATION_WINDOW_VARIABLE]: until(40 * 60_000),
    });
    expect(v.allowed).toBe(true);
    expect(v.operation).toBe('payment-providers');
    expect(v.source).toBe('manual');
  });

  it('allows every operation the runner offers, given a window', () => {
    // The fix must not quietly remove the ability to run maintenance.
    for (const op of [
      'status',
      'backup',
      'backups',
      'restore-drill',
      'india-cinema',
      'payment-routes',
      'payment-providers',
      'review-catalogue',
      'backfill-objects',
      'full-reset',
    ]) {
      const v = resolveOperation({
        SEED_OPERATION: op,
        [OPERATION_WINDOW_VARIABLE]: until(40 * 60_000),
      });
      expect(v.allowed).toBe(true);
      expect(v.operation).toBe(op);
    }
  });

  it('is case and whitespace tolerant, because a pasted value carries both', () => {
    const v = resolveOperation({
      SEED_OPERATION: '  BACKUP ',
      [OPERATION_WINDOW_VARIABLE]: until(10 * 60_000),
    });
    expect(v.operation).toBe('backup');
    expect(v.allowed).toBe(true);
  });
});

describe('it steps aside for the guards that outrank it', () => {
  it('does not judge full-reset, so the production guard still speaks first', () => {
    /*
      A production reset must be refused because of WHAT THE DATABASE IS, from environment
      variables alone, before anything connects - not because a window expired. When this guard
      ran first it refused for the weaker reason and put the stronger guard out of reach, which
      `destructive-seed-refusal.integration-postgres.spec.ts` caught immediately.

      `full-reset` also already has an expiring authorisation of its own, so a second window
      added nothing to begin with.
    */
    const v = resolveOperation({ SEED_OPERATION: 'full-reset', APP_ENV: 'PRODUCTION' }, NOW);
    expect(v.allowed).toBe(true);
    expect(v.operation).toBe('full-reset');
  });

  it('does not judge an operation nobody recognises', () => {
    // The dispatcher names the valid operations; refusing here would replace that with less.
    const v = resolveOperation({ SEED_OPERATION: 'drop-everything-please' }, NOW);
    expect(v.allowed).toBe(true);
    expect(v.operation).toBe('drop-everything-please');
  });
});

describe('the evidence line', () => {
  it('names the requested and the resolved operation side by side', () => {
    /*
      The old evidence was printed only by the backup branch, so five nights of the wrong
      operation produced no line at all - and an absence is evidence only to somebody already
      looking for it. A disagreement between these two fields is now a grep.
    */
    const line = evidenceLine({ requested: 'payment-providers', resolved: 'backup' });
    expect(line.startsWith('SEED_EVIDENCE ')).toBe(true);
    const parsed = JSON.parse(line.slice('SEED_EVIDENCE '.length));
    expect(parsed).toEqual({ requested: 'payment-providers', resolved: 'backup' });
  });

  it('survives a log pipeline as a single parseable line', () => {
    // Railway returns log lines unordered and sometimes incompletely; one line arrives whole.
    const line = evidenceLine({ backup: { name: 'etg-x.dump', bytes: 313137, verified: true } });
    expect(line.split('\n')).toHaveLength(1);
    expect(JSON.parse(line.slice('SEED_EVIDENCE '.length)).backup.verified).toBe(true);
  });
});
