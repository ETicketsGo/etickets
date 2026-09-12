import { TicketInviteKind, TicketInviteStatus } from '@eticketsgo/shared-types';

/**
 * Who holds a ticket NOW, as opposed to who paid for it.
 *
 * ── THE DEFECT THIS EXISTS FOR ─────────────────────────────────────────────────────
 * Every rule about a ticket asked `booking.userId`, which is the BUYER and never changes. An
 * accepted TRANSFER relinked the ticket to its recipient and rotated the QR — and then the
 * buyer, still `booking.userId`, was shown the new QR in their wallet, could unassign the
 * ticket (rotating the QR again and locking the recipient out), could open a guest share link
 * to it, and could ask for a refund of it. A transfer the giver can undo, copy or cash in has
 * not transferred anything.
 *
 * ── WHY IT IS DERIVED FROM THE INVITE LEDGER ───────────────────────────────────────
 * The accepted TRANSFER invite already records who took the ticket (`acceptedByUserId`) and
 * when, so the holder is read from there rather than from a new column: no migration, and it
 * is right for tickets transferred before this existed. `attendeeUserId` is deliberately NOT
 * the answer — a holder may assign the ticket onward to a friend without giving up ownership,
 * exactly as a buyer can.
 *
 * An attendee invite (kind INVITE) is not a transfer. A buyer who assigns a seat to a guest
 * still manages it; only kind TRANSFER moves ownership.
 *
 * Callers must load {@link ACCEPTED_TRANSFERS}. A ticket loaded without it reads as never
 * transferred, which is why every holder decision in this codebase goes through these helpers
 * and the fragment beside them rather than re-deriving the rule.
 */

/** The Prisma relation fragment every holder decision reads: accepted transfers, newest first. */
export const ACCEPTED_TRANSFERS = {
  where: { kind: TicketInviteKind.TRANSFER, status: TicketInviteStatus.ACCEPTED },
  // Postgres sorts NULL first under DESC. A legacy row with no timestamp must not outrank a
  // real, later transfer, or the previous holder would be handed the ticket back.
  orderBy: { resolvedAt: { sort: 'desc', nulls: 'last' } },
  select: { acceptedByUserId: true },
} as const;

export interface TicketHolderFacts {
  booking: { userId: string | null };
  /** Accepted TRANSFER invites, newest first, as loaded by {@link ACCEPTED_TRANSFERS}. */
  invites?: readonly { acceptedByUserId: string | null }[];
}

/** Whether ownership of this ticket has moved away from its buyer by an accepted transfer. */
export function isTransferred(ticket: TicketHolderFacts): boolean {
  return (ticket.invites?.length ?? 0) > 0;
}

/**
 * The account that owns the ticket now: the latest transfer's recipient, else the buyer.
 *
 * Null when nobody can be named — a guest booking, or a legacy transfer whose recipient was
 * never recorded. Null matches no user, so that case fails closed: only a platform admin can
 * act on the ticket.
 */
export function currentHolderUserId(ticket: TicketHolderFacts): string | null {
  if (!isTransferred(ticket)) return ticket.booking.userId;
  return ticket.invites![0].acceptedByUserId ?? null;
}

/**
 * Whether this user has ever owned the ticket — its buyer or any transfer recipient.
 *
 * That earns the right to SEE the ticket (it is part of their booking history), never the
 * right to present it or manage it, which belongs to {@link currentHolderUserId} alone.
 */
export function everHeldBy(ticket: TicketHolderFacts, userId: string): boolean {
  if (ticket.booking.userId === userId) return true;
  return (ticket.invites ?? []).some((i) => i.acceptedByUserId === userId);
}
