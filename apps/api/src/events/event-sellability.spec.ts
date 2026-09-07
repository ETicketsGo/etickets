import { EventSellabilityService } from './event-sellability.service';

/**
 * The checks that decide whether publishing this event would strand a customer.
 *
 * ── THE INCIDENT THESE COME FROM ───────────────────────────────────────────────────
 * A cinema in Vijayawada went live with a seat category named "PR" that had never been
 * mapped to a regulatory class. Andhra Pradesh caps ticket prices per class, so the booking
 * path — correctly — refused the sale. The person who met that refusal was a customer, at
 * the last step, after picking seats, and the sentence they were shown was about our
 * configuration: "Seat category PR has no regulatory seat class."
 *
 * Every fact needed to know that was in the database before the event was published. The
 * check was in the wrong place, not missing.
 */

type Event = Record<string, unknown> | null;

/** A Prisma stand-in returning one event. The service issues exactly one findUnique. */
function prismaWith(event: Event) {
  return { event: { findUnique: async () => event } } as never;
}

/** A cinema in a jurisdiction that caps prices, as the resolver understands one. */
const CINEMA = {
  country: 'India',
  region: 'Andhra Pradesh',
  district: 'NTR',
  city: 'Vijayawada',
  localBodyType: 'MUNICIPAL_CORPORATION',
  cinemaFormat: 'MULTIPLEX',
  climateType: 'AC',
  venue: { country: 'India', region: 'Andhra Pradesh', city: 'Vijayawada' },
};

function session(over: Record<string, unknown> = {}) {
  return {
    id: 's1',
    startsAt: new Date('2026-10-02T13:30:00.000Z'),
    seatMapId: 'map1',
    screen: { cinema: CINEMA },
    ticketTypes: [
      {
        id: 't1',
        name: 'Premium',
        priceMinor: 15000,
        currency: 'INR',
        seatCategory: { name: 'PR', regulatoryClass: null },
      },
    ],
    _count: { showSeats: 120 },
    ...over,
  };
}

function eventWith(over: Record<string, unknown> = {}) {
  return {
    id: 'e1',
    isFree: false,
    venue: { country: 'India' },
    sessions: [session()],
    ...over,
  };
}

/** A policy engine that refuses to resolve, which is what an unmapped class produces. */
const blockingPolicies = {
  resolveForCinema: async () => ({
    // The real status the resolver returns when a seat category has no class: the rate rows
    // band on classes, so an unmapped one matches nothing and the policy cannot be found.
    status: 'POLICY_NOT_FOUND',
    explanation:
      'Seat category "PR" has no regulatory seat class. This jurisdiction sets a maximum ' +
      'price per seat class.',
    policy: null,
  }),
} as never;

/** A jurisdiction with no rules, which is every non-cinema venue and most countries. */
const openPolicies = {
  resolveForCinema: async () => ({
    status: 'NOT_REGULATED',
    explanation: '',
    policy: null,
  }),
} as never;

describe('what an organizer is told before publishing', () => {
  it('refuses the exact configuration a customer met at checkout, and names the category', async () => {
    const service = new EventSellabilityService(prismaWith(eventWith()), blockingPolicies);
    const report = await service.check('e1');

    expect(report.sellable).toBe(false);
    const blocker = report.blockers.find((b) => b.code === 'SEAT_CLASS_UNMAPPED');
    expect(blocker).toBeDefined();
    /*
      The category by name. "A seat category is unmapped" sends the organizer to find which
      one; naming it is the difference between a report and a task.
    */
    expect(blocker!.subject).toBe('PR');
    expect(blocker!.message).toContain('PR');
    // And somewhere to go. A problem statement with no next action is a complaint.
    expect(blocker!.fix).toMatch(/regulatory class/i);
    expect(blocker!.fixPath).toBeTruthy();
  });

  it('says nothing about a venue in a jurisdiction with no price rules', async () => {
    const service = new EventSellabilityService(prismaWith(eventWith()), openPolicies);
    const report = await service.check('e1');
    expect(report.sellable).toBe(true);
    expect(report.blockers).toEqual([]);
  });

  it('reports a currency that disagrees with the venue as a warning, never a blocker', async () => {
    /*
      A dollar price on an Indian venue takes money successfully, which is exactly why
      nothing else catches it: the buyer's card is charged in the wrong currency and the
      organizer is paid in one they never chose. Refusing to publish over it would leave the
      organizer's only route past it a support ticket, so it is said loudly and not enforced.
    */
    const service = new EventSellabilityService(
      prismaWith(
        eventWith({
          sessions: [
            session({
              ticketTypes: [
                {
                  id: 't1',
                  name: 'Premium',
                  priceMinor: 15000,
                  currency: 'USD',
                  seatCategory: { name: 'PR', regulatoryClass: 'PREMIUM' },
                },
              ],
            }),
          ],
        }),
      ),
      openPolicies,
    );
    const report = await service.check('e1');

    expect(report.sellable).toBe(true);
    const warning = report.warnings.find((w) => w.code === 'CURRENCY_DISAGREES_WITH_VENUE');
    expect(warning).toBeDefined();
    expect(warning!.message).toContain('USD');
    expect(warning!.message).toContain('INR');
  });

  it('blocks a seated show that has no seats on it', async () => {
    // The storefront renders an empty map and every click does nothing, which reads as a
    // broken page rather than an unfinished one.
    const service = new EventSellabilityService(
      prismaWith(eventWith({ sessions: [session({ _count: { showSeats: 0 } })] })),
      openPolicies,
    );
    const report = await service.check('e1');
    expect(report.blockers.map((b) => b.code)).toContain('SEATED_SESSION_HAS_NO_SEATS');
  });

  it('blocks a free event whose tickets still carry a price, and names them', async () => {
    const service = new EventSellabilityService(
      prismaWith(eventWith({ isFree: true })),
      openPolicies,
    );
    const report = await service.check('e1');
    const blocker = report.blockers.find((b) => b.code === 'FREE_EVENT_HAS_PRICES');
    expect(blocker).toBeDefined();
    expect(blocker!.subject).toBe('Premium');
    // Both intentions are one edit away, so the message must not assume which one was meant.
    expect(blocker!.fix).toMatch(/zero.*or.*free-event/i);
  });

  it('blocks a show with no ticket types rather than reporting it as sellable', async () => {
    const service = new EventSellabilityService(
      prismaWith(eventWith({ sessions: [session({ ticketTypes: [] })] })),
      openPolicies,
    );
    const report = await service.check('e1');
    expect(report.blockers.map((b) => b.code)).toContain('NO_TICKET_TYPES');
  });

  it('blocks an event with no dates at all', async () => {
    const service = new EventSellabilityService(
      prismaWith(eventWith({ sessions: [] })),
      openPolicies,
    );
    const report = await service.check('e1');
    expect(report.blockers.map((b) => b.code)).toContain('NO_SESSIONS');
  });

  it('reports nothing regulated when no policy engine is wired at all', async () => {
    /*
      A deployment with no regulated market configured has no policy service. Every
      regulatory check is skipped rather than reporting a blocker nobody can act on --
      the same optionality the booking path already has.
    */
    const service = new EventSellabilityService(prismaWith(eventWith()));
    const report = await service.check('e1');
    expect(report.sellable).toBe(true);
  });

  it('does not claim a missing event is sellable', async () => {
    const service = new EventSellabilityService(prismaWith(null), openPolicies);
    const report = await service.check('missing');
    expect(report.sellable).toBe(false);
  });
});
