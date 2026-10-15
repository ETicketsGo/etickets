import { describe, expect, it } from 'vitest';
import { adminConsoleOrigin, adminSignInUrl, backOfficeRoute } from './admin-console-url';

const at = (hostname: string, protocol = 'https:') => ({ protocol, hostname });

describe('adminConsoleOrigin', () => {
  it('follows how the deployments are named', () => {
    expect(adminConsoleOrigin(at('organizer-qa.eticketsgo.com'), '')).toBe(
      'https://admin-qa.eticketsgo.com',
    );
    expect(adminConsoleOrigin(at('organizer-uat.eticketsgo.com'), '')).toBe(
      'https://admin-uat.eticketsgo.com',
    );
    expect(adminConsoleOrigin(at('organizer.eticketsgo.com'), '')).toBe(
      'https://admin.eticketsgo.com',
    );
    expect(adminConsoleOrigin(at('localhost', 'http:'), '')).toBe('http://localhost:3002');
  });

  it('prefers a configured address, and guesses nothing for an unknown host', () => {
    expect(adminConsoleOrigin(at('organizer-qa.eticketsgo.com'), 'https://ops.example.test/')).toBe(
      'https://ops.example.test',
    );
    expect(adminConsoleOrigin(at('preview-1.up.railway.app'), '')).toBeNull();
    expect(adminConsoleOrigin(undefined, '')).toBeNull();
  });
});

describe('adminSignInUrl', () => {
  it('fills in the address the person just signed in with', () => {
    expect(adminSignInUrl('https://admin-qa.eticketsgo.com', 'admin@eticketsgo.test')).toBe(
      'https://admin-qa.eticketsgo.com/login?email=admin%40eticketsgo.test',
    );
    expect(adminSignInUrl('https://admin-qa.eticketsgo.com', null)).toBe(
      'https://admin-qa.eticketsgo.com/login',
    );
  });
});

/*
  QA, 2026-10-15: the admin account signed in on organizer-qa and landed in "P.V.R. Cinemas"
  (it is an Owner there). The owner wants the admin dashboard; an organizer is unaffected.
*/
describe('backOfficeRoute', () => {
  const ADMIN = 'https://admin-qa.eticketsgo.com';

  it('leaves an organizer exactly where they were going', () => {
    expect(
      backOfficeRoute({ roles: ['ORGANIZER_OWNER'], adminOrigin: ADMIN, organizationCount: 1 }),
    ).toBe('stay');
  });

  it('sends an administrator with no organization straight to the admin console', () => {
    expect(backOfficeRoute({ roles: ['ADMIN'], adminOrigin: ADMIN, organizationCount: 0 })).toBe(
      'admin',
    );
  });

  it('offers the choice to an administrator who is also a member of an organization', () => {
    expect(
      backOfficeRoute({
        roles: ['SUPER_ADMIN', 'ORGANIZER_OWNER'],
        adminOrigin: ADMIN,
        organizationCount: 1,
      }),
    ).toBe('choose');
  });

  it('does not strand an administrator when the admin console address is unknown', () => {
    expect(backOfficeRoute({ roles: ['ADMIN'], adminOrigin: null, organizationCount: 0 })).toBe(
      'stay',
    );
  });
});
