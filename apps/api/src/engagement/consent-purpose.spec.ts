import { consentHistory, currentConsent, type ConsentRecord } from './consent-purpose';

const at = (s: number) => new Date(Date.UTC(2026, 9, 27, 10, 0, s));
const row = (over: Partial<ConsentRecord>): ConsentRecord => ({
  purpose: 'ORGANIZER_UPDATES',
  organizationId: 'org_a',
  channel: 'email',
  granted: true,
  source: 'test',
  policyVersion: 'MARKETING/GLOBAL/v1',
  createdAt: at(0),
  ...over,
});

describe('currentConsent', () => {
  it('reads no row as NO', () => {
    expect(currentConsent([], 'ORGANIZER_UPDATES', 'org_a')).toMatchObject({
      granted: false,
      decidedAt: null,
      source: null,
    });
  });

  it('lets the newest row win, whatever the order it arrives in', () => {
    const rows = [
      row({ granted: false, createdAt: at(5) }),
      row({ granted: true, createdAt: at(1) }),
    ];
    expect(currentConsent(rows, 'ORGANIZER_UPDATES', 'org_a').granted).toBe(false);
    expect(currentConsent(rows.slice().reverse(), 'ORGANIZER_UPDATES', 'org_a').granted).toBe(
      false,
    );
  });

  it('never lets one organizer consent stand for another, or for the platform', () => {
    const rows = [row({ organizationId: 'org_a', granted: true })];
    expect(currentConsent(rows, 'ORGANIZER_UPDATES', 'org_b').granted).toBe(false);
    expect(currentConsent(rows, 'ORGANIZER_UPDATES', null).granted).toBe(false);
  });

  it('keeps purposes and channels apart', () => {
    const rows = [row({ purpose: 'ORGANIZER_UPDATES', granted: true })];
    expect(currentConsent(rows, 'OFFERS', 'org_a').granted).toBe(false);
    expect(currentConsent(rows, 'ORGANIZER_UPDATES', 'org_a', 'sms').granted).toBe(false);
  });

  it('breaks a timestamp tie in favour of the later row', () => {
    const rows = [
      row({ granted: true, createdAt: at(3) }),
      row({ granted: false, createdAt: at(3) }),
    ];
    expect(currentConsent(rows, 'ORGANIZER_UPDATES', 'org_a').granted).toBe(false);
  });
});

describe('consentHistory', () => {
  it('is newest first and can be narrowed to one organizer', () => {
    const rows = [
      row({ createdAt: at(1), organizationId: 'org_a' }),
      row({ createdAt: at(3), organizationId: 'org_b' }),
      row({ createdAt: at(2), organizationId: 'org_a', granted: false }),
    ];
    expect(consentHistory(rows).map((r) => r.createdAt)).toEqual([at(3), at(2), at(1)]);
    expect(consentHistory(rows, { organizationId: 'org_a' })).toHaveLength(2);
  });
});
