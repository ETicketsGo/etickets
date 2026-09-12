'use client';

import { useTranslations } from 'next-intl';
import { titleCase } from '@eticketsgo/web-kit';

/** What the status belongs to. It decides the wording — and, in French, the grammatical gender. */
export type StatusKind = 'booking' | 'ticket' | 'refund';

/*
  One map per kind rather than one shared list, because French agrees the word with its noun:
  a booking (la réservation) is "Remboursée", a ticket (le billet) is "Remboursé". A single
  list would be wrong for one of them on every French page.
*/
const NAMESPACE: Record<StatusKind, string> = {
  booking: 'status',
  ticket: 'ticketStatus',
  refund: 'refundStatus',
};

/**
 * The status in the reader's language, for `StatusBadge`'s `label`.
 *
 * The badge spelled out the enum in English, so French pages showed "PENDING PAYMENT" and
 * "REFUNDED" (found on QA). A status the catalogue does not name yet is still shown, spelled
 * out as before, rather than hidden.
 */
export function useStatusLabel() {
  const tx = useTranslations('common');
  return (kind: StatusKind, status: string): string => {
    const key = `${NAMESPACE[kind]}.${status}`;
    return tx.has(key) ? tx(key) : titleCase(status);
  };
}
