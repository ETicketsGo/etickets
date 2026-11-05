import {
  CampaignAction as A,
  CampaignStatus as S,
  finishStatus,
  transition,
  type CampaignAction,
  type CampaignStatus,
} from './campaign-state';

/**
 * The campaign lifecycle, row by row. Every allowed move is listed; every other (status,
 * action) pair must be refused. A new transition fails this test until it is written here.
 */
const ALLOWED: Array<[CampaignStatus, CampaignAction, CampaignStatus]> = [
  [S.DRAFT, A.EDIT, S.DRAFT],
  [S.DRAFT, A.SCHEDULE, S.SCHEDULED],
  [S.DRAFT, A.SUBMIT_FOR_APPROVAL, S.PENDING_APPROVAL],
  [S.DRAFT, A.SEND_NOW, S.QUEUED],
  [S.DRAFT, A.CANCEL, S.CANCELLED],
  [S.SCHEDULED, A.RESCHEDULE, S.SCHEDULED],
  [S.SCHEDULED, A.UNSCHEDULE, S.DRAFT],
  [S.SCHEDULED, A.SEND_NOW, S.QUEUED],
  [S.SCHEDULED, A.PROMOTE, S.QUEUED],
  [S.SCHEDULED, A.CANCEL, S.CANCELLED],
  [S.PENDING_APPROVAL, A.APPROVE, S.SCHEDULED],
  [S.PENDING_APPROVAL, A.REJECT, S.DRAFT],
  [S.PENDING_APPROVAL, A.CANCEL, S.CANCELLED],
  [S.QUEUED, A.START, S.SENDING],
  [S.QUEUED, A.PAUSE, S.PAUSED],
  [S.QUEUED, A.CANCEL, S.CANCELLED],
  [S.QUEUED, A.FAIL, S.FAILED],
  [S.SENDING, A.PAUSE, S.PAUSED],
  [S.SENDING, A.FAIL, S.FAILED],
  [S.PAUSED, A.RESUME, S.QUEUED],
  [S.PAUSED, A.CANCEL, S.CANCELLED],
];

const ALL_STATUSES = Object.values(S);
const ALL_ACTIONS = Object.values(A).filter((a) => a !== A.FINISH);

describe('campaign state machine', () => {
  it.each(ALLOWED)('%s --%s--> %s', (from, action, to) => {
    expect(transition(from, action)).toEqual({ ok: true, to });
  });

  const allowedKey = new Set(ALLOWED.map(([f, a]) => `${f}|${a}`));
  const refused = ALL_STATUSES.flatMap((f) =>
    ALL_ACTIONS.filter((a) => !allowedKey.has(`${f}|${a}`)).map((a) => [f, a] as const),
  );
  it.each(refused)('refuses %s --%s', (from, action) => {
    const r = transition(from, action);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/\w/);
  });

  it('a sending campaign cannot be cancelled in one step: pause first', () => {
    const r = transition(S.SENDING, A.CANCEL);
    expect(r).toEqual({ ok: false, reason: expect.stringMatching(/Pause it first/) });
  });

  it('a finished campaign refuses everything, pointing at duplicate', () => {
    for (const final of [S.COMPLETED, S.PARTIALLY_FAILED, S.FAILED, S.CANCELLED]) {
      for (const action of Object.values(A)) {
        const r = transition(final, action, {});
        expect(r.ok).toBe(false);
        if (!r.ok) expect(r.reason).toMatch(/Duplicate/);
      }
    }
  });

  describe('FINISH', () => {
    it('needs counts, and refuses while anybody is still owed a send', () => {
      expect(transition(S.SENDING, A.FINISH).ok).toBe(false);
      expect(transition(S.SENDING, A.FINISH, { PENDING: 1, ACCEPTED: 4 }).ok).toBe(false);
      expect(transition(S.SENDING, A.FINISH, { QUEUED: 1 }).ok).toBe(false);
    });
    it.each([
      [{ ACCEPTED: 3, DELIVERED: 2 }, S.COMPLETED],
      [{ SKIPPED_CONSENT: 5 }, S.COMPLETED],
      [{ DELIVERED: 2, BOUNCED: 1, COMPLAINED: 1 }, S.COMPLETED],
      [{ DELIVERED: 2, FAILED: 1 }, S.PARTIALLY_FAILED],
      [{ FAILED: 3, SKIPPED_SUPPRESSED: 1 }, S.FAILED],
    ] as const)('%j -> %s', (counts, expected) => {
      expect(finishStatus(counts)).toBe(expected);
      expect(transition(S.SENDING, A.FINISH, counts)).toEqual({ ok: true, to: expected });
    });
    it('only a SENDING campaign finishes', () => {
      expect(transition(S.QUEUED, A.FINISH, { DELIVERED: 1 }).ok).toBe(false);
      expect(transition(S.PAUSED, A.FINISH, { DELIVERED: 1 }).ok).toBe(false);
    });
  });
});
