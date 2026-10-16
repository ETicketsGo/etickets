import { describe, expect, it } from 'vitest';
import { removalSummary } from './team-removal';

const member = (revoked?: {
  devices: number;
  activations: number;
  sessions: number;
  signedOut: boolean;
}) => ({
  id: 'm1',
  role: 'CHECKIN_STAFF',
  status: 'REMOVED',
  user: { id: 'u1', email: 'door@example.test', fullName: 'Dev Door' },
  revoked,
});

describe('the removal toast', () => {
  it('names what was taken back with the person', () => {
    expect(
      removalSummary(member({ devices: 2, activations: 1, sessions: 3, signedOut: true })),
    ).toBe(
      'Dev Door has been removed. Their access has ended: 2 check-in devices turned off, 1 offline check-in approval withdrawn, signed out everywhere.',
    );
  });

  it('does not claim a sign-out that did not happen', () => {
    const text = removalSummary(
      member({ devices: 1, activations: 0, sessions: 0, signedOut: false }),
    );
    expect(text).toBe(
      'Dev Door has been removed. Their access has ended: 1 check-in device turned off.',
    );
    expect(text).not.toMatch(/signed out/);
  });

  it('says only the removal when an older API reports nothing else', () => {
    expect(removalSummary(member())).toBe('Dev Door has been removed. Their access has ended.');
  });
});
