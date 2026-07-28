import { AppException } from '../../common/errors';
import { AnonymousSessionService, BookingOwnerResolver } from './booking-owner';

describe('AnonymousSessionService', () => {
  const svc = new AnonymousSessionService();

  it('issues a well-formed, high-entropy, prefixed token that it recognizes', () => {
    const a = svc.issueToken();
    const b = svc.issueToken();
    expect(a).not.toEqual(b); // not guessable / not derived from stable input
    expect(a.startsWith('anon_')).toBe(true);
    expect(a.length).toBeGreaterThan(40);
    expect(svc.isWellFormed(a)).toBe(true);
    expect(svc.isWellFormed('u1')).toBe(false);
    expect(svc.isWellFormed(undefined)).toBe(false);
  });

  it('persists only a hash and matches it in constant time', () => {
    const token = svc.issueToken();
    const hash = svc.hash(token);
    expect(hash).not.toEqual(token); // raw token never stored
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    expect(svc.matches(token, hash)).toBe(true);
    expect(svc.matches(svc.issueToken(), hash)).toBe(false);
  });
});

describe('BookingOwnerResolver', () => {
  const anon = new AnonymousSessionService();
  const resolver = new BookingOwnerResolver(anon);

  it('prefers the authenticated principal over any anonymous token (no body override)', () => {
    const token = anon.issueToken();
    const owner = resolver.resolveForRequest({
      user: { id: 'u1', email: '', fullName: '', roles: [] },
      anonymousToken: token,
    });
    expect(owner).toEqual({ ownerType: 'USER', ownerId: 'u1' });
  });

  it('resolves an anonymous session to a hashed owner id (never the raw token)', () => {
    const token = anon.issueToken();
    const owner = resolver.resolveForRequest({ user: null, anonymousToken: token });
    expect(owner.ownerType).toBe('ANONYMOUS_SESSION');
    expect(owner.ownerId).toEqual(anon.hash(token));
    expect(owner.ownerId).not.toEqual(token);
  });

  it('rejects a request with neither a principal nor a valid guest token', () => {
    expect(() => resolver.resolveForRequest({ user: null, anonymousToken: 'garbage' })).toThrow(
      AppException,
    );
  });

  it('assertOwner: a different user cannot access another user’s workflow', () => {
    const wf = { ownerType: 'USER', ownerId: 'userA' };
    expect(() => resolver.assertOwner(wf, { ownerType: 'USER', ownerId: 'userB' })).toThrow(
      AppException,
    );
    expect(() => resolver.assertOwner(wf, { ownerType: 'USER', ownerId: 'userA' })).not.toThrow();
  });

  it('assertOwner: one anonymous session cannot access another session’s workflow', () => {
    const s1 = anon.hash(anon.issueToken());
    const s2 = anon.hash(anon.issueToken());
    const wf = { ownerType: 'ANONYMOUS_SESSION', ownerId: s1 };
    expect(() => resolver.assertOwner(wf, { ownerType: 'ANONYMOUS_SESSION', ownerId: s2 })).toThrow(
      AppException,
    );
  });

  it('assertOwner: a user and an anonymous session with matching id strings still mismatch by type', () => {
    const wf = { ownerType: 'USER', ownerId: 'x' };
    expect(() =>
      resolver.assertOwner(wf, { ownerType: 'ANONYMOUS_SESSION', ownerId: 'x' }),
    ).toThrow(AppException);
  });

  it('assertOwner: legacy pre-ownership workflows (null owner) delegate, never falsely reject', () => {
    expect(() =>
      resolver.assertOwner(
        { ownerType: null, ownerId: null },
        { ownerType: 'USER', ownerId: 'anyone' },
      ),
    ).not.toThrow();
  });

  it('internal() yields an explicit privileged context, never a customer identity', () => {
    const ctx = resolver.internal('hold-expiry-worker');
    expect(ctx.ownerType).toBe('INTERNAL');
    expect(ctx.ownerId).toContain('internal:');
    expect(ctx.actor).toBe('hold-expiry-worker');
  });
});
