import { errorMessage } from '@eticketsgo/web-kit';

/**
 * What to tell an organizer when deleting a ticket type is refused.
 *
 * A ticket type that any booking or ticket names (a fully refunded one too) is kept, because
 * that is order history. The API refuses with TICKET_TYPE_HAS_HISTORY
 * (apps/api/src/common/errors.ts); this says what to do instead. ASCII only, plain English.
 */
export const TICKET_TYPE_HAS_HISTORY_MESSAGE =
  'This ticket has orders, including refunded ones, so it cannot be deleted. Deactivate it to stop selling it.';

export function ticketTypeDeleteErrorMessage(err: unknown): string {
  const code = (err as { code?: unknown } | null | undefined)?.code;
  if (code === 'TICKET_TYPE_HAS_HISTORY') return TICKET_TYPE_HAS_HISTORY_MESSAGE;
  return errorMessage(err);
}
