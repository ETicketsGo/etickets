import {
  categoryOf,
  groupNotifications,
  sectionFeed,
  type EventResolution,
  type FeedSourceRow,
} from './notification-feed';

/**
 * The notification centre's grouping, stated as the organizer sees it.
 *
 * ── THE REPORT THESE COME FROM ─────────────────────────────────────────────────────
 * One regulatory seating problem on a film ("Balcony seats need regulatory classification")
 * filled the organizer's notifications page with the same full sentence once per showtime:
 * dozens of rows, one problem, one fix, and no way to tell from the page that they were the
 * same thing. These pin the rule that folds them: same type, same event, same cause, one card.
 */

const T0 = Date.parse('2026-10-01T06:00:00.000Z');
let seq = 0;

function row(
  payload: Record<string, unknown>,
  opts: { type?: string; readAt?: Date | null; minutes?: number } = {},
): FeedSourceRow {
  seq += 1;
  return {
    id: `n${seq}`,
    type: opts.type ?? 'EVENT_NOT_SELLABLE',
    payload,
    subject: `subject ${seq}`,
    body: `body ${seq}`,
    readAt: opts.readAt ?? null,
    createdAt: new Date(T0 + (opts.minutes ?? seq) * 60_000),
  };
}

function show(i: number) {
  return {
    id: `s${i}`,
    startsAt: new Date(T0 + i * 86_400_000).toISOString(),
    timeZone: 'Asia/Kolkata',
  };
}

const BALCONY = {
  eventId: 'e-telugu',
  eventTitle: 'Telugu Movie',
  reason: 'Balcony is not mapped to a regulatory seat class, and this jurisdiction caps the price.',
  blockerCodes: 'SEAT_CLASS_UNMAPPED:Balcony@/organizer/cinemas/c1/readiness',
  blockerCode: 'SEAT_CLASS_UNMAPPED',
  owner: 'ORGANIZER',
  subject: 'Balcony',
  fix: 'Map every seat category to a regulatory class.',
  fixPath: '/organizer/cinemas/c1/readiness',
};

const OVER_CEILING = {
  ...BALCONY,
  reason: 'Recliner is priced above what its seat class permits.',
  blockerCodes: 'PRICE_OVER_CEILING:Recliner@/organizer/events/e-telugu/sessions',
  blockerCode: 'PRICE_OVER_CEILING',
  subject: 'Recliner',
  fixPath: '/organizer/events/e-telugu/sessions',
};

/** Eighteen notifications, one per showtime, all about the same cause. */
const perShowFlood = () =>
  Array.from({ length: 18 }, (_, i) => {
    const s = show(i + 1);
    return row({ ...BALCONY, eventSessionId: s.id, startsAt: s.startsAt, timeZone: s.timeZone });
  });

describe('folding one cause into one card', () => {
  it('turns eighteen per-showtime notifications of one cause into one card listing all eighteen', () => {
    const rows = perShowFlood();
    const groups = groupNotifications(rows);

    expect(groups).toHaveLength(1);
    const [card] = groups;
    expect(card.notificationIds).toHaveLength(18);
    expect(card.sessions.map((s) => s.id)).toEqual(
      Array.from({ length: 18 }, (_, i) => `s${i + 1}`),
    );
    expect(card.affectedSessions).toBe(18);
    expect(card.title).toBe('Telugu Movie - Ticket sales blocked');
    expect(card.summary).toBe('Balcony seats need a regulatory seat class. 18 showtimes affected.');
    expect(card.category).toBe('ACTION_REQUIRED');
    expect(card.severity).toBe('CRITICAL');
  });

  it('reads the same card from one notification that lists its eighteen showtimes', () => {
    const sessions = Array.from({ length: 18 }, (_, i) => show(i + 1));
    const [card] = groupNotifications([row({ ...BALCONY, affectedSessions: 18, sessions })]);

    expect(card.sessions).toHaveLength(18);
    expect(card.summary).toBe('Balcony seats need a regulatory seat class. 18 showtimes affected.');
    // The button goes where the fix is, named for what the organizer will do there.
    expect(card.action).toEqual({
      label: 'Map seat classes',
      href: '/organizer/cinemas/c1/readiness',
    });
    // The producer's precise sentence and its fix are kept, behind the summary.
    expect(card.detail).toContain('is not mapped to a regulatory seat class');
    expect(card.detail).toContain('Map every seat category');
  });

  it('keeps two different causes on one event as two cards', () => {
    const groups = groupNotifications([row(BALCONY), row(OVER_CEILING), row(BALCONY)]);
    expect(groups).toHaveLength(2);
    expect(groups.map((g) => g.action?.label).sort()).toEqual([
      'Fix ticket prices',
      'Map seat classes',
    ]);
  });

  it('keeps the same cause on two events as two cards', () => {
    const groups = groupNotifications([
      row(BALCONY),
      row({ ...BALCONY, eventId: 'e-other', eventTitle: 'Other Film' }),
    ]);
    expect(groups).toHaveLength(2);
    expect(groups.map((g) => g.title).sort()).toEqual([
      'Other Film - Ticket sales blocked',
      'Telugu Movie - Ticket sales blocked',
    ]);
  });

  it('folds older notifications whose sentence names a different day each time', () => {
    /*
      Written before causes had an identity: the code set in `blockerCodes`, and a reason that
      names the date the policy was checked. Folding on the sentence would make one card a day.
    */
    const legacy = (day: string) =>
      row({
        eventId: 'e-telugu',
        eventTitle: 'Telugu Movie',
        blockerCodes: 'NO_PRICING_POLICY',
        reason: `India has active cinema pricing policies but none covers Telangana on ${day}. (148 shows)`,
      });
    const groups = groupNotifications([legacy('2026-10-01'), legacy('2026-10-02')]);
    expect(groups).toHaveLength(1);
    expect(groups[0].notificationIds).toHaveLength(2);
  });

  it('never folds unrelated notifications of other types together', () => {
    const groups = groupNotifications([
      row({ settlementId: 'st1' }, { type: 'SETTLEMENT_RELEASED' }),
      row({ settlementId: 'st2' }, { type: 'SETTLEMENT_RELEASED' }),
      row({ settlementId: 'st1' }, { type: 'TRANSFER_FAILED' }),
      row({ settlementId: 'st1' }, { type: 'TRANSFER_FAILED' }),
    ]);
    // Two payouts stay two; one transfer retried twice is one card saying so.
    expect(groups).toHaveLength(3);
    const failed = groups.find((g) => g.type === 'TRANSFER_FAILED')!;
    expect(failed.notificationIds).toHaveLength(2);
  });
});

describe('read state', () => {
  it('is read only when every notification folded into it is read', () => {
    const rows = perShowFlood();
    rows.slice(0, 17).forEach((r) => (r.readAt = new Date(T0)));

    const [card] = groupNotifications(rows);
    expect(card.read).toBe(false);
    expect(card.unreadIds).toEqual([rows[17].id]);

    rows[17].readAt = new Date(T0);
    const [after] = groupNotifications(rows);
    expect(after.read).toBe(true);
    expect(after.unreadIds).toEqual([]);
  });

  it('does not let a read action-required card be dismissed while the problem stands', () => {
    const rows = perShowFlood().map((r) => ({ ...r, readAt: new Date(T0) }));
    const [card] = groupNotifications(rows);
    expect(card.read).toBe(true);
    expect(card.dismissible).toBe(false);

    // And it stays in its section, first, read or not.
    const sections = sectionFeed(groupNotifications(rows));
    expect(sections[0].category).toBe('ACTION_REQUIRED');
    expect(sections[0].groups).toHaveLength(1);
  });

  it('lets information be dismissed whether or not it has been read', () => {
    const [card] = groupNotifications([row({ eventId: 'e1' }, { type: 'EVENT_APPROVED' })]);
    expect(card.category).toBe('EVENT_APPROVALS');
    expect(card.dismissible).toBe(true);
    expect(card.severity).toBe('SUCCESS');
  });
});

describe('whether the problem is still there', () => {
  const live = (r: Partial<EventResolution>): EventResolution => ({
    clear: false,
    causes: new Set(),
    codes: new Set(),
    ...r,
  });

  it('is unknown, and so still a problem, when nothing was checked', () => {
    const [card] = groupNotifications([row(BALCONY)]);
    expect(card.resolved).toBeNull();
    expect(card.dismissible).toBe(false);
  });

  it('is fixed when the live check no longer finds that cause', () => {
    const lookup = () => live({ causes: new Set([OVER_CEILING.blockerCodes]) });
    const groups = groupNotifications([row(BALCONY), row(OVER_CEILING)], lookup);

    const balcony = groups.find((g) => g.summary.startsWith('Balcony'))!;
    const recliner = groups.find((g) => g.summary.startsWith('Recliner'))!;
    expect(balcony.resolved).toBe(true);
    expect(balcony.severity).toBe('SUCCESS');
    expect(balcony.dismissible).toBe(true);
    // A fixed problem offers no fix.
    expect(balcony.action).toBeNull();
    expect(recliner.resolved).toBe(false);
    expect(recliner.action?.label).toBe('Fix ticket prices');
    expect(recliner.dismissible).toBe(false);

    // The cause still standing reads first.
    const [section] = sectionFeed(groups);
    expect(section.groups[0].summary.startsWith('Recliner')).toBe(true);
  });

  it('reads an older code-set notification as fixed only when none of its codes remain', () => {
    const legacy = row({
      eventId: 'e-telugu',
      blockerCodes: 'NO_PRICING_POLICY+PRICE_OVER_CEILING',
    });
    const still = groupNotifications([legacy], () =>
      live({ codes: new Set(['PRICE_OVER_CEILING']) }),
    );
    expect(still[0].resolved).toBe(false);
    const gone = groupNotifications([legacy], () => live({ codes: new Set(['NO_SESSIONS']) }));
    expect(gone[0].resolved).toBe(true);
  });

  it('is fixed for every cause when the event is clear', () => {
    const groups = groupNotifications([row(BALCONY), row(OVER_CEILING)], () =>
      live({ clear: true }),
    );
    expect(groups.every((g) => g.resolved === true)).toBe(true);
  });
});

describe('who can fix it', () => {
  it('offers no button for a fault only the platform can fix, and says so', () => {
    const [card] = groupNotifications([
      row({
        eventId: 'e-telugu',
        eventTitle: 'Telugu Movie',
        blockerCodes: 'NO_PRICING_POLICY',
        blockerCode: 'NO_PRICING_POLICY',
        owner: 'PLATFORM',
        fixPath: null,
        reason: 'None covers Telangana.',
        affectedSessions: 148,
      }),
    ]);
    expect(card.action).toBeNull();
    expect(card.ownerNote).toMatch(/We are fixing this/);
    expect(card.summary).toBe(
      'Ticket price rules for this area are not set up yet. 148 showtimes affected.',
    );
  });
});

describe('types with no template', () => {
  it('titles them in words instead of the type name and a JSON dump', () => {
    const r = {
      ...row({ settlementId: 'st1' }, { type: 'SETTLEMENT_RELEASED' }),
      templated: false,
    };
    const [card] = groupNotifications([r]);
    expect(card.title).toBe('Payout released');
    expect(card.summary).not.toContain('{');
  });

  it('keeps the rendered words when a template exists', () => {
    const [card] = groupNotifications([row({ eventId: 'e1' }, { type: 'EVENT_APPROVED' })]);
    expect(card.title).toMatch(/^subject /);
  });
});

describe('sections', () => {
  it('puts a type nobody has classified under System updates', () => {
    expect(categoryOf('SOMETHING_NEW')).toBe('SYSTEM_UPDATES');
  });

  it('orders sections with Action required first and leaves out empty ones', () => {
    const sections = sectionFeed(
      groupNotifications([
        row({ x: 1 }, { type: 'SOMETHING_NEW' }),
        row({ settlementId: 'st1' }, { type: 'SETTLEMENT_RELEASED' }),
        row(BALCONY),
        row({ eventId: 'e1' }, { type: 'EVENT_APPROVED' }),
      ]),
    );
    expect(sections.map((s) => s.label)).toEqual([
      'Action required',
      'Event approvals',
      'Payments and payouts',
      'System updates',
    ]);
  });
});
