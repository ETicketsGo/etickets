import { Role } from '@eticketsgo/shared-types';
import { removedSessionOrg } from './jwt.strategy';
import { hasBearer } from '../support/optional-jwt-auth.guard';

/**
 * The rule that ends a session a team removal signed out (see removedSessionOrg). It has to
 * agree with OrganizationsService.removeMember about WHEN a removal signs somebody out, or it
 * either leaves a "signed out everywhere" session running or throws out a person who was not
 * signed out at all.
 */
describe('removedSessionOrg', () => {
  const removedAt = new Date('2026-10-16T10:00:00.500Z');
  const before = Math.floor(new Date('2026-10-16T09:59:00Z').getTime() / 1000);
  const after = Math.floor(new Date('2026-10-16T10:00:05Z').getTime() / 1000);
  const removed = { status: 'REMOVED', updatedAt: removedAt, organizationId: 'org-a' };

  it('refuses a token issued before the removal of the last seat, naming the org', () => {
    expect(removedSessionOrg(before, [Role.CUSTOMER], [removed])).toBe('org-a');
  });

  it('lets a session started after the removal through', () => {
    expect(removedSessionOrg(after, [Role.CUSTOMER], [removed])).toBeNull();
  });

  it('treats a token from the same second as the removal as older (the safe side)', () => {
    const sameSecond = Math.floor(removedAt.getTime() / 1000);
    expect(removedSessionOrg(sameSecond, [Role.CUSTOMER], [removed])).toBe('org-a');
  });

  it('does nothing while another seat is still active (removal did not sign them out)', () => {
    const other = { status: 'ACTIVE', updatedAt: new Date(0), organizationId: 'org-b' };
    expect(removedSessionOrg(before, [Role.CUSTOMER], [removed, other])).toBeNull();
  });

  it('does nothing for platform staff, whom a removal never signs out', () => {
    expect(removedSessionOrg(before, [Role.ADMIN], [removed])).toBeNull();
    expect(removedSessionOrg(before, [Role.SUPER_ADMIN], [removed])).toBeNull();
  });

  it('does nothing for an account that never lost a seat', () => {
    expect(removedSessionOrg(before, [Role.CUSTOMER], [])).toBeNull();
  });

  it('uses the latest removal when there were several', () => {
    const older = {
      status: 'REMOVED',
      updatedAt: new Date('2026-10-01T00:00:00Z'),
      organizationId: 'org-old',
    };
    expect(removedSessionOrg(before, [Role.CUSTOMER], [older, removed])).toBe('org-a');
  });

  it('does nothing for a token with no issued-at', () => {
    expect(removedSessionOrg(undefined, [Role.CUSTOMER], [removed])).toBeNull();
  });
});

describe('hasBearer (OptionalJwtAuthGuard)', () => {
  it('only a bearer credential counts as a claim to be somebody', () => {
    expect(hasBearer('Bearer abc.def.ghi')).toBe(true);
    expect(hasBearer('bearer abc')).toBe(true);
    expect(hasBearer(undefined)).toBe(false);
    expect(hasBearer('')).toBe(false);
    expect(hasBearer('Bearer ')).toBe(false);
    expect(hasBearer('Basic dXNlcjpwYXNz')).toBe(false);
  });
});
