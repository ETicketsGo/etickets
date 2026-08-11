import {
  evaluatePilotReadiness,
  overallReadiness,
  READINESS_SECTIONS,
  type ReadinessFacts,
} from './pilot-readiness';

/**
 * Readiness rules.
 *
 * The value of this module is that a theater manager can answer "what is stopping this
 * cinema going live?" without asking engineering — so the tests are mostly about whether the
 * right things BLOCK, and whether the messages name the actual problem.
 */
const facts = (over: Partial<ReadinessFacts> = {}): ReadinessFacts => ({
  cinemaId: 'cin1',
  organization: { status: 'ACTIVE', contactEmail: 'ops@t.test', contactPhone: '+91' },
  cinema: { timezone: 'Asia/Kolkata', status: 'ACTIVE', address: '1 Road', city: 'Hyderabad' },
  activeScreens: 2,
  totalScreens: 2,
  activeScreensWithoutPublishedLayout: [],
  operatorCount: 3,
  pricedCategories: 2,
  unpricedCategories: 0,
  activeFeeRules: 4,
  hasCancellationPolicy: true,
  hasInrPaymentRoute: true,
  paymentProviderConfigured: true,
  futurePublishedShows: 12,
  publicCatalogueReachable: true,
  ...over,
});

const codes = (f: ReadinessFacts) => evaluatePilotReadiness(f).map((c) => c.code);
const find = (f: ReadinessFacts, code: string) =>
  evaluatePilotReadiness(f).find((c) => c.code === code);

describe('a fully configured cinema', () => {
  it('is READY with no blockers or warnings', () => {
    const checks = evaluatePilotReadiness(facts());
    expect(overallReadiness(checks)).toBe('READY');
    expect(checks.filter((c) => c.level !== 'READY')).toEqual([]);
  });

  it('reports on every section, so nothing is silently unchecked', () => {
    const covered = new Set(evaluatePilotReadiness(facts()).map((c) => c.section));
    for (const section of READINESS_SECTIONS) {
      expect(covered.has(section)).toBe(true);
    }
  });
});

describe('what blocks a launch', () => {
  it.each([
    [
      'a suspended organization',
      { organization: { status: 'SUSPENDED', contactEmail: 'a@b.c', contactPhone: null } },
      'ORG_NOT_ACTIVE',
    ],
    ['no screens in service', { activeScreens: 0, totalScreens: 0 }, 'NO_ACTIVE_SCREEN'],
    [
      'an in-service screen with no layout',
      { activeScreensWithoutPublishedLayout: ['Screen 2'] },
      'SCREEN_WITHOUT_PUBLISHED_LAYOUT',
    ],
    ['nobody to operate it', { operatorCount: 0 }, 'NO_OPERATOR'],
    ['no priced seat category', { pricedCategories: 0 }, 'NO_PRICING'],
    ['no INR payment route', { hasInrPaymentRoute: false }, 'NO_INR_ROUTE'],
    ['no provider credentials', { paymentProviderConfigured: false }, 'PROVIDER_NOT_CONFIGURED'],
    ['nothing scheduled', { futurePublishedShows: 0 }, 'NO_FUTURE_SHOWS'],
    ['nothing discoverable', { publicCatalogueReachable: false }, 'CATALOGUE_UNREACHABLE'],
    [
      'an inactive cinema',
      { cinema: { timezone: 'Asia/Kolkata', status: 'INACTIVE', address: 'x', city: 'Hyd' } },
      'CINEMA_NOT_ACTIVE',
    ],
  ])('%s blocks', (_label, over, code) => {
    const f = facts(over as Partial<ReadinessFacts>);
    expect(find(f, code)?.level).toBe('BLOCKED');
    expect(overallReadiness(evaluatePilotReadiness(f))).toBe('BLOCKED');
  });

  it('names the screens that are unusable, not just the count', () => {
    // "One screen is misconfigured" sends an operator hunting. Naming it does not.
    const f = facts({ activeScreensWithoutPublishedLayout: ['Screen 2', 'Screen 3'] });
    expect(find(f, 'SCREEN_WITHOUT_PUBLISHED_LAYOUT')?.message).toContain('Screen 2, Screen 3');
  });

  it('distinguishes no screens from all screens out of service', () => {
    expect(find(facts({ activeScreens: 0, totalScreens: 0 }), 'NO_ACTIVE_SCREEN')?.message).toMatch(
      /No screens have been created/,
    );
    expect(find(facts({ activeScreens: 0, totalScreens: 3 }), 'NO_ACTIVE_SCREEN')?.message).toMatch(
      /All 3 screens are out of service/,
    );
  });

  it('every blocker offers somewhere to go and fix it', () => {
    const blocked = evaluatePilotReadiness(
      facts({
        activeScreens: 0,
        totalScreens: 0,
        operatorCount: 0,
        pricedCategories: 0,
        hasInrPaymentRoute: false,
        futurePublishedShows: 0,
        publicCatalogueReachable: false,
      }),
    ).filter((c) => c.level === 'BLOCKED');

    expect(blocked.length).toBeGreaterThan(4);

    /*
      Every blocker must be ACTIONABLE — but "actionable" is not always a link.

      Payment routing and provider credentials are platform configuration: the theater cannot
      fix them at all, and the old version of this test demanded a fixPath for them, which is
      what produced links into an admin app no operator can open. The honest invariant is that
      a blocker either offers a route OR names who owns it.

      Asserted as lists so a failure names the offending codes rather than just the first.
    */
    const unactionable = blocked
      .filter((b) => !b.fixPath && !/contact support|ETicketsGo/i.test(b.message))
      .map((b) => b.code);
    expect(unactionable).toEqual([]);
    expect(blocked.filter((b) => b.message.length <= 20).map((b) => b.code)).toEqual([]);
  });
});

describe('what only warns', () => {
  it.each([
    [
      'no support email',
      { organization: { status: 'ACTIVE', contactEmail: null, contactPhone: null } },
      'NO_SUPPORT_EMAIL',
    ],
    [
      'no street address',
      { cinema: { timezone: 'Asia/Kolkata', status: 'ACTIVE', address: null, city: 'Hyd' } },
      'NO_ADDRESS',
    ],
    ['a single operator', { operatorCount: 1 }, 'SINGLE_OPERATOR'],
    ['no fee rule', { activeFeeRules: 0 }, 'NO_FEE_RULE'],
    ['no cancellation policy', { hasCancellationPolicy: false }, 'NO_CANCELLATION_POLICY'],
    ['some unpriced categories', { unpricedCategories: 2 }, 'UNPRICED_CATEGORIES'],
  ])('%s warns but does not block', (_label, over, code) => {
    const f = facts(over as Partial<ReadinessFacts>);
    expect(find(f, code)?.level).toBe('WARNING');
    expect(overallReadiness(evaluatePilotReadiness(f))).toBe('WARNING');
  });

  it('a lone operator is flagged because a pilot night has no second pair of hands', () => {
    expect(find(facts({ operatorCount: 1 }), 'SINGLE_OPERATOR')?.message).toMatch(
      /pause sales|release a seat/,
    );
  });

  it('no fee rule says it may be deliberate rather than accusing', () => {
    // Selling with no convenience fee is a valid commercial choice on a pilot.
    expect(find(facts({ activeFeeRules: 0 }), 'NO_FEE_RULE')?.message).toMatch(/confirm it/i);
  });
});

describe('overallReadiness', () => {
  it('lets a blocker outrank any number of warnings', () => {
    const f = facts({ activeFeeRules: 0, operatorCount: 0, hasCancellationPolicy: false });
    expect(overallReadiness(evaluatePilotReadiness(f))).toBe('BLOCKED');
  });

  it('never blocks on warnings alone', () => {
    // A checklist that refuses to let anyone proceed over an optional field is one people
    // learn to route around, and then it stops being read at all.
    const f = facts({ activeFeeRules: 0, hasCancellationPolicy: false, unpricedCategories: 1 });
    expect(overallReadiness(evaluatePilotReadiness(f))).toBe('WARNING');
  });
});

describe('fix paths must be followable by the operator who sees them', () => {
  /*
    Found by a QA rehearsal, not by reasoning.

    Two checks pointed at `/admin/fees` and `/admin/payments`. `/admin/fees` is not a route at
    all, and BOTH live in the admin application — a theater operator has no account there and
    cannot open either. A dead link presented as "Fix this" is worse than no link: it spends
    the operator's trust and then strands them.

    Those checks now carry `fixPath: null` and say who owns the task instead. This test stops
    the class of defect returning, rather than just the two instances.
  */
  const everyCheck = () =>
    evaluatePilotReadiness(
      facts({
        organization: { status: 'SUSPENDED', contactEmail: null, contactPhone: null },
        cinema: { timezone: '', status: 'INACTIVE', address: null, city: 'Hyd' },
        activeScreens: 0,
        totalScreens: 2,
        activeScreensWithoutPublishedLayout: ['S1'],
        operatorCount: 0,
        pricedCategories: 0,
        unpricedCategories: 1,
        activeFeeRules: 0,
        hasCancellationPolicy: false,
        hasInrPaymentRoute: false,
        paymentProviderConfigured: false,
        futurePublishedShows: 0,
        publicCatalogueReachable: false,
      }),
    );

  it('never sends an organizer into the admin application', () => {
    const crossApp = everyCheck()
      .filter((c) => c.fixPath?.startsWith('/admin'))
      .map((c) => c.code);
    expect(crossApp).toEqual([]);
  });

  it('only ever points at the organizer app', () => {
    const foreign = everyCheck()
      .filter((c) => c.fixPath !== null && !c.fixPath.startsWith('/organizer/'))
      .map((c) => `${c.code} -> ${c.fixPath}`);
    expect(foreign).toEqual([]);
  });

  it('a check with no fix path still says who owns the task', () => {
    // Otherwise the operator is told something is wrong and given no route at all.
    const unactionable = everyCheck()
      .filter((c) => c.level !== 'READY' && c.fixPath === null)
      .filter((c) => !/contact support|ETicketsGo/i.test(c.message))
      .map((c) => c.code);
    expect(unactionable).toEqual([]);
  });
});

describe('codes are stable identifiers', () => {
  it('are unique, so the UI can key off them', () => {
    const all = codes(facts({ activeScreens: 0, operatorCount: 0, pricedCategories: 0 }));
    expect(new Set(all).size).toBe(all.length);
  });

  it('carry no interpolated data, so they can be matched on', () => {
    const bad = evaluatePilotReadiness(facts({ activeScreensWithoutPublishedLayout: ['S2'] }))
      .map((c) => c.code)
      .filter((code) => !/^[A-Z0-9_]+$/.test(code));
    expect(bad).toEqual([]);
  });
});
