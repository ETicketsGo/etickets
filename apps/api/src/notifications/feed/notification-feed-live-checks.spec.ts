import { NotificationFeedService } from './notification-feed.service';

/**
 * Every "Ticket sales blocked" card in view is checked against the live sale state.
 *
 * On QA a tax-rule change raised a card for every published event at once. The feed checked only
 * the first 5 events, so 21 cards for events that were selling again stayed "blocked" for ever,
 * and Overview said "26 items block sales" beside a Coming up list showing those same events as
 * Selling. This pins that a season's worth of cards is checked, a few at a time.
 */
describe('NotificationFeedService live checks', () => {
  const EVENTS = 24;
  const rows = Array.from({ length: EVENTS }, (_, i) => ({
    id: `n${i}`,
    type: 'EVENT_NOT_SELLABLE',
    locale: 'en',
    payload: {
      eventId: `e${i}`,
      eventTitle: `Event ${i}`,
      reason: 'No tax classification.',
      blockerCodes: 'TAX_CLASSIFICATION_MISSING:e',
      blockerCode: 'TAX_CLASSIFICATION_MISSING',
      owner: 'ORGANIZER',
      fixPath: `/organizer/events/e${i}/edit`,
      affectedSessions: 1,
    },
    readAt: null,
    createdAt: new Date(Date.now() - i * 1000),
  }));

  function build() {
    let inFlight = 0;
    let peak = 0;
    const checked: string[] = [];
    const prisma = {
      notification: { findMany: jest.fn(async () => rows) },
      event: {
        findUnique: jest.fn(async () => ({ status: 'PUBLISHED', sessions: [{ id: 's1' }] })),
      },
    };
    const sellability = {
      check: jest.fn(async (eventId: string) => {
        inFlight += 1;
        peak = Math.max(peak, inFlight);
        await new Promise((r) => setTimeout(r, 5));
        inFlight -= 1;
        checked.push(eventId);
        return { eventId, sellable: true, blockers: [], warnings: [], checkedAt: '' };
      }),
    };
    const templates = {
      render: () => ({ subject: 'Ticket sales blocked', body: 'No tax classification.' }),
      hasTemplate: () => true,
    };
    const notifications = { unreadCount: async () => EVENTS };
    const service = new NotificationFeedService(
      prisma as never,
      templates as never,
      notifications as never,
      sellability as never,
    );
    return { service, checked, peak: () => peak };
  }

  it('checks every event in view, not just the first five', async () => {
    const { service, checked } = build();
    const feed = await service.feed('u1', 'ORGANIZER');
    expect(checked).toHaveLength(EVENTS);
    const groups = feed.sections.flatMap((s) => s.groups);
    expect(groups).toHaveLength(EVENTS);
    // Every one of them is selling again, so none may still read as blocked.
    expect(groups.every((g) => g.resolved === true)).toBe(true);
  });

  it('runs the checks a few at a time', async () => {
    const { service, peak } = build();
    await service.feed('u1', 'ORGANIZER');
    expect(peak()).toBeLessThanOrEqual(5);
    expect(peak()).toBeGreaterThan(1);
  });
});
