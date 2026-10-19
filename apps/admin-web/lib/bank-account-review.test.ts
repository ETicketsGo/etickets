import { describe, expect, it } from 'vitest';
import { independenceNote, queueOrder } from './bank-account-review';

describe('the reason an admin may not verify, said before they click', () => {
  it('names the person who entered the details', () => {
    expect(independenceNote('SAME_PERSON')).toBe(
      'You entered these bank details, so a different staff member must verify them.',
    );
  });

  it('names membership of the organization', () => {
    expect(independenceNote('ORGANIZATION_MEMBER')).toContain('You belong to this organization');
  });

  it('says nothing when the admin may decide', () => {
    expect(independenceNote(null)).toBeNull();
    expect(independenceNote(undefined)).toBeNull();
  });
});

describe('the order the bank accounts are listed in', () => {
  it('puts waiting accounts first, oldest first', () => {
    const rows = [
      { id: 'v', status: 'VERIFIED', updatedAt: '2026-01-01T00:00:00Z' },
      { id: 'new', status: 'PENDING_VERIFICATION', updatedAt: '2026-10-18T00:00:00Z' },
      { id: 'old', status: 'PENDING_VERIFICATION', updatedAt: '2026-10-01T00:00:00Z' },
    ];
    expect(queueOrder(rows).map((r) => r.id)).toEqual(['old', 'new', 'v']);
  });
});
