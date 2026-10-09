import { NotificationType } from '@eticketsgo/shared-types';
import { EventSellabilitySweepService } from './event-sellability-sweep.service';
import type { SellabilityIssue, SellabilityReport } from './event-sellability.service';
import { dedupeKeyFor } from '../notifications/policy/dedupe-key';

/**
 * The sweep tells an organizer about each ROOT CAUSE once.
 *
 * ── WHY THESE EXIST ────────────────────────────────────────────────────────────────
 * The sweep had no tests. It sent one message per event keyed on the SET of fault codes, so a
 * fault that persisted was announced again whenever another appeared or was fixed beside it,
 * and the message carried neither the affected shows nor where to fix it. The notification
 * centre then had nothing to fold on, and listed the same sentence once per message.
 */

const shows = (n: number) =>
  Array.from({ length: n }, (_, i) => ({
    id: `s${i + 1}`,
    startsAt: new Date(Date.UTC(2026, 9, 10 + i, 13, 30)).toISOString(),
    timeZone: 'Asia/Kolkata',
  }));

const BALCONY: SellabilityIssue = {
  code: 'SEAT_CLASS_UNMAPPED',
  owner: 'ORGANIZER',
  message: 'Balcony is not mapped to a regulatory seat class.',
  fix: 'Map every seat category to a regulatory class.',
  fixPath: '/organizer/cinemas/c1/readiness',
  subject: 'Balcony',
  affectedSessions: 18,
  sessions: shows(18),
};

const RECLINER: SellabilityIssue = {
  code: 'PRICE_OVER_CEILING',
  owner: 'ORGANIZER',
  message: 'Recliner is priced above what its seat class permits.',
  fix: 'Lower the price.',
  fixPath: '/organizer/events/e1/sessions',
  subject: 'Recliner',
  affectedSessions: 3,
  sessions: shows(3),
};

const NO_POLICY: SellabilityIssue = {
  code: 'NO_PRICING_POLICY',
  owner: 'PLATFORM',
  message: 'None covers Telangana on 2026-10-09.',
  fix: 'Nothing here can fix this.',
  fixPath: null,
  affectedSessions: 148,
  sessions: shows(148),
};

function report(blockers: SellabilityIssue[]): SellabilityReport {
  return {
    eventId: 'e1',
    sellable: blockers.length === 0,
    blockers,
    warnings: [],
    checkedAt: new Date().toISOString(),
  };
}

function setup(reports: SellabilityReport[]) {
  const prisma = {
    event: {
      findMany: jest
        .fn()
        .mockResolvedValue([{ id: 'e1', title: 'Telugu Movie', organizationId: 'org1' }]),
    },
  };
  const check = jest.fn();
  for (const r of reports) check.mockResolvedValueOnce(r);
  const notifyOrganizationOwners = jest.fn().mockResolvedValue(1);
  const notifyAdmins = jest.fn().mockResolvedValue(1);
  const sweep = new EventSellabilitySweepService(
    prisma as never,
    { check } as never,
    { notifyOrganizationOwners, notifyAdmins } as never,
  );
  /** The payloads the owners were sent, in order. */
  const payloads = () =>
    notifyOrganizationOwners.mock.calls.map((c) => c[2] as Record<string, unknown>);
  return { sweep, notifyOrganizationOwners, notifyAdmins, payloads };
}

/** The key the database would store for an in-app copy to one owner. */
const keyOf = (payload: Record<string, unknown>) =>
  dedupeKeyFor({
    type: NotificationType.EVENT_NOT_SELLABLE,
    channel: 'in_app',
    recipientRef: 'owner-1',
    payload,
  });

describe('one message per root cause', () => {
  it('sends one message for a cause spread over eighteen shows, naming all eighteen', async () => {
    const { sweep, notifyOrganizationOwners, payloads } = setup([report([BALCONY])]);
    await sweep.sweep();

    expect(notifyOrganizationOwners).toHaveBeenCalledTimes(1);
    const [payload] = payloads();
    expect(payload.eventId).toBe('e1');
    expect(payload.blockerCode).toBe('SEAT_CLASS_UNMAPPED');
    expect(payload.fixPath).toBe('/organizer/cinemas/c1/readiness');
    expect(payload.affectedSessions).toBe(18);
    expect((payload.sessions as unknown[]).length).toBe(18);
    expect(payload.reason).toBe('Balcony is not mapped to a regulatory seat class. (18 shows)');
  });

  it('sends one message per distinct cause, each with its own key', async () => {
    const { sweep, payloads } = setup([report([BALCONY, RECLINER])]);
    await sweep.sweep();

    const sent = payloads();
    expect(sent.map((p) => p.blockerCode)).toEqual(['SEAT_CLASS_UNMAPPED', 'PRICE_OVER_CEILING']);
    expect(keyOf(sent[0])).not.toBe(keyOf(sent[1]));
  });

  it('produces the same key on the next run, so the database discards the repeat', async () => {
    const { sweep, payloads } = setup([report([BALCONY]), report([BALCONY])]);
    await sweep.sweep();
    await sweep.sweep();

    const [first, second] = payloads();
    expect(keyOf(first)).not.toBeNull();
    expect(keyOf(second)).toBe(keyOf(first));
  });

  it('does not re-announce a cause that persists when a new one appears beside it', async () => {
    const { sweep, payloads } = setup([report([BALCONY]), report([BALCONY, RECLINER])]);
    await sweep.sweep();
    await sweep.sweep();

    const [run1Balcony, run2Balcony, run2Recliner] = payloads();
    // The persisting cause keeps its key: its second send is a duplicate the index drops.
    expect(keyOf(run2Balcony)).toBe(keyOf(run1Balcony));
    // The new cause is new news.
    expect(keyOf(run2Recliner)).not.toBe(keyOf(run1Balcony));
  });

  it('keeps the key the previous version wrote for a lone platform fault', async () => {
    /*
      The earlier sweep keyed every event on its sorted code set. For an event whose only
      fault is a missing policy that set was the bare code, and so is this cause's identity -
      so the first run of this version does not announce it all over again.
    */
    const { sweep, payloads } = setup([report([NO_POLICY])]);
    await sweep.sweep();

    const [payload] = payloads();
    const previous = keyOf({ eventId: 'e1', blockerCodes: 'NO_PRICING_POLICY' });
    expect(keyOf(payload)).toBe(previous);
  });

  it('caps the listed shows and keeps the full count', async () => {
    const { sweep, payloads } = setup([report([NO_POLICY])]);
    await sweep.sweep();

    const [payload] = payloads();
    expect((payload.sessions as unknown[]).length).toBe(100);
    expect(payload.affectedSessions).toBe(148);
  });

  it('still tells the platform about faults only the platform can fix', async () => {
    const { sweep, notifyAdmins } = setup([report([NO_POLICY, BALCONY])]);
    await sweep.sweep();
    expect(notifyAdmins).toHaveBeenCalledTimes(1);
  });
});
