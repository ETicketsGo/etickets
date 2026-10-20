import {
  announcedCauses,
  causeIdentity,
  legacyAnnouncedCodes,
  legacyCoverage,
  normaliseCauseIdentity,
} from './sellability-cause';

/**
 * Reading what a message of the EARLIER shape already told its recipient.
 *
 * The earlier sweep keyed one message per event on the "+"-joined code set. These pin down
 * which stored payloads count as having announced a code, because a wrong answer either way
 * is a real cost: too generous and a different fault goes unannounced, too strict and the
 * first run after deploy re-sends every standing fault.
 */
describe('legacyAnnouncedCodes', () => {
  const codes = (payload: unknown) => [...legacyAnnouncedCodes(payload)].sort();

  it('reads every code of an earlier code set', () => {
    expect(
      codes({ eventId: 'e1', blockerCodes: 'PRICE_OVER_CEILING+SEAT_CLASS_UNMAPPED', reason: 'x' }),
    ).toEqual(['PRICE_OVER_CEILING', 'SEAT_CLASS_UNMAPPED']);
  });

  it('reads a lone code', () => {
    expect(codes({ eventId: 'e1', blockerCodes: 'NO_PRICING_POLICY' })).toEqual([
      'NO_PRICING_POLICY',
    ]);
  });

  it('ignores a row of the current shape, which names its own cause', () => {
    // Its code must not cover another subject with the same code: Balcony is not Box.
    const current = {
      eventId: 'e1',
      blockerCodes: causeIdentity({
        code: 'SEAT_CLASS_UNMAPPED',
        subject: 'Balcony',
        fixPath: '/organizer/cinemas/c1/readiness',
      }),
      blockerCode: 'SEAT_CLASS_UNMAPPED',
    };
    expect(codes(current)).toEqual([]);
    // Even a bare-code cause of the current shape: its key already does the work.
    expect(codes({ eventId: 'e1', blockerCodes: 'NO_PRICING_POLICY', blockerCode: 'X' })).toEqual(
      [],
    );
  });

  it("ignores the platform team's copy, which is no evidence the organizer was told", () => {
    expect(
      codes({ eventId: 'e1', organizationId: 'org1', blockerCodes: 'NO_PRICING_POLICY' }),
    ).toEqual([]);
  });

  it('reads nothing from a value that is not a set of plain codes', () => {
    expect(codes({ eventId: 'e1', blockerCodes: 'SEAT_CLASS_UNMAPPED:Balcony@/x' })).toEqual([]);
    expect(codes({ eventId: 'e1', blockerCodes: 'A+' })).toEqual([]);
    expect(codes({ eventId: 'e1', blockerCodes: '' })).toEqual([]);
    expect(codes({ eventId: 'e1', blockerCodes: 42 })).toEqual([]);
    expect(codes({ eventId: 'e1' })).toEqual([]);
    expect(codes(null)).toEqual([]);
    expect(codes('NO_PRICING_POLICY')).toEqual([]);
    expect(codes(['NO_PRICING_POLICY'])).toEqual([]);
  });
});

describe('legacyCoverage', () => {
  it('collects codes per recipient across every earlier row and channel', () => {
    const map = legacyCoverage([
      { userId: 'u1', payload: { eventId: 'e1', blockerCodes: 'SEAT_CLASS_UNMAPPED' } },
      // The in-app copy of a later message, after a second fault appeared beside the first.
      {
        userId: 'u1',
        payload: { eventId: 'e1', blockerCodes: 'PRICE_OVER_CEILING+SEAT_CLASS_UNMAPPED' },
      },
      { userId: 'u2', payload: { eventId: 'e1', blockerCodes: 'NO_PRICING_POLICY' } },
      // Not of the earlier shape: contributes nothing, and no empty entry either.
      { userId: 'u3', payload: { eventId: 'e1', blockerCodes: 'X', blockerCode: 'X' } },
      // A message with no account behind it cannot be matched to an owner.
      { userId: null, payload: { eventId: 'e1', blockerCodes: 'NO_SEATS' } },
    ]);
    expect([...map.keys()].sort()).toEqual(['u1', 'u2']);
    expect([...map.get('u1')!].sort()).toEqual(['PRICE_OVER_CEILING', 'SEAT_CLASS_UNMAPPED']);
    expect([...map.get('u2')!]).toEqual(['NO_PRICING_POLICY']);
  });
});

describe('normaliseCauseIdentity', () => {
  it('drops the anchor and query from the fix path, which only scroll the page', () => {
    expect(
      normaliseCauseIdentity(
        'SEAT_CLASS_UNMAPPED:Platinum Executive@/organizer/cinemas/c1/readiness#seat-classes',
      ),
    ).toBe('SEAT_CLASS_UNMAPPED:Platinum Executive@/organizer/cinemas/c1/readiness');
    expect(normaliseCauseIdentity('NO_SEATS@/organizer/venues?tab=rooms')).toBe(
      'NO_SEATS@/organizer/venues',
    );
  });

  it('keeps the page, which is what separates two cinemas missing the same mapping', () => {
    expect(
      normaliseCauseIdentity('SEAT_CLASS_UNMAPPED:Balcony@/organizer/cinemas/c2/readiness'),
    ).toBe('SEAT_CLASS_UNMAPPED:Balcony@/organizer/cinemas/c2/readiness');
  });

  it('leaves a bare code and a code with a subject alone', () => {
    expect(normaliseCauseIdentity('NO_PRICING_POLICY')).toBe('NO_PRICING_POLICY');
    expect(normaliseCauseIdentity('SEAT_CLASS_UNMAPPED:Box')).toBe('SEAT_CLASS_UNMAPPED:Box');
  });

  it('is what causeIdentity produces, so new keys never carry an anchor', () => {
    expect(
      causeIdentity({
        code: 'SEAT_CLASS_UNMAPPED',
        subject: 'Box',
        fixPath: '/organizer/cinemas/c1/readiness#seat-classes',
      }),
    ).toBe('SEAT_CLASS_UNMAPPED:Box@/organizer/cinemas/c1/readiness');
  });
});

describe('announcedCauses', () => {
  it('collects the normalised causes each recipient was told, of the current shape only', () => {
    const map = announcedCauses([
      {
        userId: 'u1',
        payload: {
          blockerCode: 'SEAT_CLASS_UNMAPPED',
          blockerCodes: 'SEAT_CLASS_UNMAPPED:Box@/organizer/cinemas/c1/readiness#seat-classes',
        },
      },
      // The earlier shape: read by legacyCoverage, not here.
      { userId: 'u1', payload: { blockerCodes: 'NO_PRICING_POLICY' } },
      // The platform team's copy is no evidence the organizer was told.
      {
        userId: 'u2',
        payload: { organizationId: 'o1', blockerCode: 'X', blockerCodes: 'X' },
      },
    ]);
    expect([...(map.get('u1') ?? [])]).toEqual([
      'SEAT_CLASS_UNMAPPED:Box@/organizer/cinemas/c1/readiness',
    ]);
    expect(map.has('u2')).toBe(false);
  });
});
