import type { PayoutAccount } from '@eticketsgo/web-kit';

/**
 * Why maker-checker will refuse THIS admin, said before they click rather than after.
 *
 * The API computes it per row with the rule the decision routes enforce. An owner who is also
 * staff used to be shown "Mark checked", press it, and only then learn it could never work.
 */
export function independenceNote(block: PayoutAccount['independenceBlock']): string | null {
  if (block === 'SAME_PERSON') {
    return 'You entered these bank details, so a different staff member must verify them.';
  }
  if (block === 'ORGANIZATION_MEMBER') {
    return 'You belong to this organization, so a staff member outside it must verify its bank details.';
  }
  return null;
}

/** Waiting accounts first, oldest save first: the order somebody working the queue needs. */
export function queueOrder<T extends { status: string; updatedAt: string }>(
  rows: readonly T[],
): T[] {
  const waiting = rows
    .filter((r) => r.status === 'PENDING_VERIFICATION')
    .sort((a, b) => a.updatedAt.localeCompare(b.updatedAt));
  return [...waiting, ...rows.filter((r) => r.status !== 'PENDING_VERIFICATION')];
}
