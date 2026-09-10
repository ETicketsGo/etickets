import { EventSellabilityService } from './event-sellability.service';

/**
 * Who is being asked to act, and how many times.
 *
 * ── THE INCIDENT THESE COME FROM ───────────────────────────────────────────────────
 * An organizer in Hyderabad published a 148-show film season and was shown 148 identical
 * cards, each naming a different date, each reading "cannot be sold: India has active cinema
 * pricing policies but none covers Telangana / Hyderabad", and each offering a link labelled
 * "Go and fix this" pointing at the cinema readiness page.
 *
 * Nothing on that page writes a pricing policy for a state. Telangana ships with metadata and
 * no rates deliberately — the figures come from a government order this platform will not
 * invent — so no organizer action of any kind could have cleared it. The platform sent
 * somebody hunting for a control that does not exist, 148 times over.
 *
 * The resolver had always told these cases apart. The sellability check was throwing that
 * distinction away and printing one sentence, with one link, for all of them.
 */

function prismaWith(event: Record<string, unknown> | null) {
  return { event: { findUnique: async () => event } } as never;
}

const CINEMA = {
  country: 'India',
  region: 'Telangana',
  district: 'Hyderabad',
  city: 'Hyderabad',
  localBodyType: 'MUNICIPAL_CORPORATION',
  cinemaFormat: 'MULTIPLEX',
  climateType: 'AC',
  venue: { country: 'India', region: 'Telangana', city: 'Hyderabad' },
};

/** A show whose seat category IS mapped, so the unmapped-class branch is not what is tested. */
function show(id: string, startsAt: string) {
  return {
    id,
    startsAt: new Date(startsAt),
    seatMapId: 'map1',
    screen: { cinema: CINEMA },
    ticketTypes: [
      {
        id: `t-${id}`,
        name: 'Premium',
        priceMinor: 15000,
        currency: 'INR',
        seatCategory: { name: 'PR', regulatoryClass: 'PREMIUM' },
      },
    ],
    _count: { showSeats: 120 },
  };
}

function eventWith(sessions: Record<string, unknown>[]) {
  return { id: 'e1', isFree: false, venue: { country: 'India' }, sessions };
}

/** Ticket prices here are set by an order nobody has been able to configure. */
const uncoveredJurisdiction = {
  resolveForCinema: async () => ({
    status: 'POLICY_NOT_FOUND',
    explanation:
      'India has active cinema pricing policies but none covers Telangana / Hyderabad on 2026-09-10.',
    policy: null,
  }),
} as never;

/** The jurisdiction prices by classification and this cinema has none — the organizer's field. */
const unclassifiedCinema = {
  resolveForCinema: async () => ({
    status: 'INVALID_CINEMA_CLASSIFICATION',
    explanation:
      'This jurisdiction prices by cinema classification, and this cinema has not been classified.',
    policy: null,
  }),
} as never;

/** Two equally specific rules. Nobody outside the platform can choose between them. */
const contradictoryPolicies = {
  resolveForCinema: async () => ({
    status: 'POLICY_CONFIGURATION_ERROR',
    explanation: '2 equally specific policies match this order.',
    policy: null,
  }),
} as never;

const ONE_SHOW = [show('s1', '2026-09-19T06:00:00.000Z')];

describe('who can actually fix it', () => {
  it('does not send the organizer anywhere for a jurisdiction with no pricing policy', async () => {
    const service = new EventSellabilityService(
      prismaWith(eventWith(ONE_SHOW)),
      uncoveredJurisdiction,
    );
    const { blockers } = await service.check('e1');

    const blocker = blockers.find((b) => b.code === 'NO_PRICING_POLICY');
    expect(blocker).toBeDefined();
    expect(blocker!.owner).toBe('PLATFORM');
    // The defect, stated as a test: there was a link, and it led nowhere useful.
    expect(blocker!.fixPath).toBeNull();
    expect(blocker!.fix).toContain('Nothing here can fix this');
  });

  it('does send them to the cinema when the cinema is what is unclassified', async () => {
    const service = new EventSellabilityService(
      prismaWith(eventWith(ONE_SHOW)),
      unclassifiedCinema,
    );
    const { blockers } = await service.check('e1');

    const blocker = blockers.find((b) => b.code === 'CINEMA_NOT_CLASSIFIED');
    expect(blocker).toBeDefined();
    // This one really is theirs, and the link really does reach the control.
    expect(blocker!.owner).toBe('ORGANIZER');
    expect(blocker!.fixPath).toBe('/organizer/cinemas');
  });

  it('treats contradictory platform rules as the platform’s', async () => {
    const service = new EventSellabilityService(
      prismaWith(eventWith(ONE_SHOW)),
      contradictoryPolicies,
    );
    const { blockers } = await service.check('e1');

    const blocker = blockers.find((b) => b.code === 'PRICING_POLICY_CONFLICT');
    expect(blocker!.owner).toBe('PLATFORM');
    expect(blocker!.fixPath).toBeNull();
  });

  it('never offers a fix link on anything the organizer cannot act on', async () => {
    // The invariant behind all of the above, asserted directly so a new code cannot break it.
    for (const policies of [uncoveredJurisdiction, contradictoryPolicies]) {
      const service = new EventSellabilityService(prismaWith(eventWith(ONE_SHOW)), policies);
      const { blockers } = await service.check('e1');
      const platform = blockers.filter((b) => b.owner === 'PLATFORM');
      expect(platform.length).toBeGreaterThan(0);
      for (const b of platform) expect(b.fixPath).toBeNull();
    }
  });

  it('gives every issue an owner, so the panel never has to guess', async () => {
    const service = new EventSellabilityService(
      prismaWith(
        eventWith([
          show('s1', '2026-09-19T06:00:00.000Z'),
          { ...show('s2', '2026-09-20T06:00:00.000Z'), ticketTypes: [] },
        ]),
      ),
      uncoveredJurisdiction,
    );
    const { blockers, warnings } = await service.check('e1');
    for (const issue of [...blockers, ...warnings]) {
      expect(['ORGANIZER', 'PLATFORM']).toContain(issue.owner);
    }
  });
});

describe('one fault, however many shows carry it', () => {
  const manyShows = Array.from({ length: 148 }, (_, i) =>
    show(`s${i}`, `2026-09-${String((i % 28) + 1).padStart(2, '0')}T06:00:00.000Z`),
  );

  it('folds 148 identical faults into one issue carrying the count', async () => {
    const service = new EventSellabilityService(
      prismaWith(eventWith(manyShows)),
      uncoveredJurisdiction,
    );
    const { blockers } = await service.check('e1');

    expect(blockers).toHaveLength(1);
    expect(blockers[0].affectedSessions).toBe(148);
  });

  it('names no date in the folded message', async () => {
    const service = new EventSellabilityService(
      prismaWith(eventWith(manyShows)),
      uncoveredJurisdiction,
    );
    const { blockers } = await service.check('e1');
    // A per-show date in the sentence is precisely what made one fault look like 148.
    expect(blockers[0].message).not.toMatch(/2026-09-\d\dT06:00/);
  });

  it('drops the lone session id once more than one show is affected', async () => {
    const service = new EventSellabilityService(
      prismaWith(eventWith(manyShows)),
      uncoveredJurisdiction,
    );
    const { blockers } = await service.check('e1');
    // A single id beside a count of 148 would suggest the other 147 were something else.
    expect(blockers[0].eventSessionId).toBeUndefined();
  });

  it('keeps the session id when exactly one show is affected', async () => {
    const service = new EventSellabilityService(
      prismaWith(eventWith(ONE_SHOW)),
      uncoveredJurisdiction,
    );
    const { blockers } = await service.check('e1');
    expect(blockers[0].affectedSessions).toBe(1);
    expect(blockers[0].eventSessionId).toBe('s1');
  });

  it('does NOT fold two genuinely different faults together', async () => {
    /*
      The counter-test, and the one that matters most. A fold keyed too loosely would hide a
      real second problem behind the count of the first — worse than the 148 cards it
      replaced, because at least those were all true.
    */
    const service = new EventSellabilityService(
      prismaWith(
        eventWith([
          show('s1', '2026-09-19T06:00:00.000Z'),
          { ...show('s2', '2026-09-20T06:00:00.000Z'), ticketTypes: [] },
        ]),
      ),
      uncoveredJurisdiction,
    );
    const { blockers } = await service.check('e1');
    const codes = blockers.map((b) => b.code);
    expect(codes).toContain('NO_TICKET_TYPES');
    expect(codes).toContain('NO_PRICING_POLICY');
  });
});
