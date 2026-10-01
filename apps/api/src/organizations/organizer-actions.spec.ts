import { organizerActions, type OperationalFacts } from './organizer-actions';
import { organizationReadiness, type ReadinessInput } from './organization-readiness';

/**
 * The claim under test is composition: this must agree with `organizationReadiness` rather than
 * re-decide anything it already decided, and it must never reach into event territory.
 */
const COMPLETE: ReadinessInput = {
  status: 'APPROVED',
  legalName: 'DeepTrics Software Solutions',
  legalEntityType: 'Private limited company',
  registeredCountry: 'India',
  registeredAddressLine1: '1 Road',
  registeredCity: 'Hyderabad',
  financeContactEmail: 'finance@example.test',
  grievanceOfficerName: 'Asha',
  grievanceOfficerEmail: 'asha@example.test',
  contactEmail: 'support@example.test',
  // Present so COMPLETE really is complete: readiness suggests a tax registration when absent,
  // which is right (it is optional in India below the GST threshold) and made this fixture lie.
  taxRegistrationNumber: '29ABCDE1234F1Z5',
  hasPayoutAccount: true,
  payoutAccountVerified: true,
  logoUrl: 'https://example.test/logo.png',
  description: 'We put on shows.',
};
const BUILT: OperationalFacts = {
  venueCount: 2,
  seatingRoomCount: 1,
  teamMemberCount: 3,
  publishedEventCount: 4,
};
const NOTHING: OperationalFacts = {
  venueCount: 0,
  seatingRoomCount: 0,
  teamMemberCount: 0,
  publishedEventCount: 0,
};

describe('organizerActions', () => {
  it('carries every readiness gap through, with its own key and words', () => {
    /*
      Composition, not reimplementation. If this ever stops agreeing with `organizationReadiness`
      item for item, the second source of truth is back.
    */
    const input: ReadinessInput = { ...COMPLETE, legalName: null, financeContactEmail: null };
    const expected = organizationReadiness(input);
    const summary = organizerActions('org1', input, BUILT);
    for (const item of expected) {
      const action = summary.actions.find((a) => a.key === item.key);
      expect(action).toBeDefined();
      expect(action!.title).toBe(item.title);
      expect(action!.consequence).toBe(item.consequence);
      expect(action!.fixPath).toBe(item.fixPath);
      expect(action!.severity).toBe(item.severity);
    }
  });

  it('never scopes an organization action to an event', () => {
    /*
      THE boundary. An organization with an unfinished profile can still have a perfectly sellable
      event, and a complete profile does not make an event with an unmapped seat class sellable.
      Event sellability stays authoritative for events; this list must never speak for one.
    */
    const summary = organizerActions('org1', { ...COMPLETE, legalName: null }, NOTHING);
    for (const action of summary.actions) {
      expect(action.scope).toBe('ORGANIZATION');
      expect(action.eventId).toBeUndefined();
    }
  });

  it('never claims an organization gap blocks a sale', () => {
    // Readiness calls items BLOCKING when somebody cannot be paid or approved, which is not the
    // same as "you cannot sell". Saying otherwise to force completion would be a lie.
    const summary = organizerActions('org1', { ...COMPLETE, hasPayoutAccount: false }, NOTHING);
    expect(summary.actions.every((a) => a.blocking === false)).toBe(true);
  });

  it('asks about being paid exactly once', () => {
    /*
      The one genuine duplicate of the old world: readiness asked from `hasPayoutAccount` and the
      client checklist asked from `canSellPaidTickets`, with different words and different rules.
      Readiness keeps it; the operational list must not reintroduce a second.
    */
    const summary = organizerActions('org1', { ...COMPLETE, hasPayoutAccount: false }, NOTHING);
    const money = summary.actions.filter((a) => a.category === 'MONEY');
    expect(money).toHaveLength(1);
    expect(money[0].key).toBe('payout-account');
    expect(summary.actions.filter((a) => /payout/i.test(a.key))).toHaveLength(1);
  });

  it('reports operational work as done or not from the facts it is given', () => {
    const nothing = organizerActions('org1', COMPLETE, NOTHING);
    const built = organizerActions('org1', COMPLETE, BUILT);
    const doneKeys = (s: typeof built) =>
      s.actions
        .filter((a) => a.done)
        .map((a) => a.key)
        .sort();
    expect(doneKeys(nothing)).toEqual([]);
    expect(doneKeys(built)).toEqual(['experience', 'seating', 'team', 'venue']);
  });

  it('counts progress without the optional step', () => {
    // A promoter selling standing tickets never draws a seat map and is not 3-of-4 because of it.
    const built = organizerActions('org1', COMPLETE, { ...BUILT, seatingRoomCount: 0 });
    expect(built.progress).toEqual({ done: 3, total: 3 });
    const seating = built.actions.find((a) => a.key === 'seating')!;
    expect(seating.optional).toBe(true);
    expect(seating.done).toBe(false);
  });

  it('is complete for an organization that has done everything', () => {
    const summary = organizerActions('org1', COMPLETE, BUILT);
    expect(summary.progress.done).toBe(summary.progress.total);
    expect(summary.counts).toEqual({ blocking: 0, important: 0, suggested: 0 });
  });

  it('counts only what is still outstanding', () => {
    const summary = organizerActions('org1', { ...COMPLETE, hasPayoutAccount: false }, NOTHING);
    const outstanding = summary.actions.filter((a) => !a.done);
    expect(summary.counts.blocking + summary.counts.important + summary.counts.suggested).toBe(
      outstanding.length,
    );
  });

  it('sends the first venue to a form that opens, not to the page it is rendered on', () => {
    // This pointed at `/organizer/onboarding`, where the checklist lives, so "Add venue"
    // navigated to the page you were already on and nothing happened.
    const none = organizerActions('org1', COMPLETE, NOTHING).actions.find(
      (a) => a.key === 'venue',
    )!;
    expect(none.fixPath).toBe('/organizer/venues?new=1');
    const some = organizerActions('org1', COMPLETE, BUILT).actions.find((a) => a.key === 'venue')!;
    expect(some.fixPath).toBe('/organizer/venues');
  });

  it('gives every action a destination and a label', () => {
    // An action nobody can act on is a notification, and this list is not for those.
    for (const action of organizerActions('org1', { ...COMPLETE, legalName: null }, NOTHING)
      .actions) {
      expect(action.fixPath.startsWith('/organizer')).toBe(true);
      expect(action.actionLabel.length).toBeGreaterThan(0);
      expect(action.consequence.length).toBeGreaterThan(0);
    }
  });

  it('puts business gaps before work that has not been built', () => {
    const summary = organizerActions('org1', { ...COMPLETE, legalName: null }, NOTHING);
    const firstOperational = summary.actions.findIndex((a) => a.category === 'OPERATIONS');
    const lastReadiness = summary.actions.map((a) => a.category !== 'OPERATIONS').lastIndexOf(true);
    expect(lastReadiness).toBeLessThan(firstOperational);
  });
});
