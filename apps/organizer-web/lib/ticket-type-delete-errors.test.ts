import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ApiRequestError } from '@eticketsgo/web-kit';
import {
  TICKET_TYPE_HAS_HISTORY_MESSAGE,
  TICKET_TYPE_IN_BUNDLE_MESSAGE,
  ticketTypeDeleteErrorMessage,
} from './ticket-type-delete-errors';

/*
  QA 2026-10-28: deleting a fully refunded ticket type was a 500 ("Something went wrong.").
  The API now refuses with TICKET_TYPE_HAS_HISTORY, and the console says what to do instead.
*/
describe('ticketTypeDeleteErrorMessage', () => {
  it('says to deactivate a ticket type with order history', () => {
    const err = new ApiRequestError('TICKET_TYPE_HAS_HISTORY', 'server text', {}, 'c1', 409);
    expect(ticketTypeDeleteErrorMessage(err)).toBe(TICKET_TYPE_HAS_HISTORY_MESSAGE);
    expect(TICKET_TYPE_HAS_HISTORY_MESSAGE).toMatch(/Deactivate/);
    // eslint-disable-next-line no-control-regex
    expect(TICKET_TYPE_HAS_HISTORY_MESSAGE).toMatch(/^[\x00-\x7F]*$/);
  });

  it('says to remove it from the bundle when only a bundle names it', () => {
    const err = new ApiRequestError('TICKET_TYPE_IN_BUNDLE', 'server text', {}, 'c1', 409);
    expect(ticketTypeDeleteErrorMessage(err)).toBe(TICKET_TYPE_IN_BUNDLE_MESSAGE);
    expect(TICKET_TYPE_IN_BUNDLE_MESSAGE).toMatch(/bundle/);
    expect(TICKET_TYPE_IN_BUNDLE_MESSAGE).not.toMatch(/orders/);
    // eslint-disable-next-line no-control-regex
    expect(TICKET_TYPE_IN_BUNDLE_MESSAGE).toMatch(/^[\x00-\x7F]*$/);
  });

  it('keeps the API sentence for any other refusal', () => {
    const err = new ApiRequestError('CONFLICT', 'It has sales or holds.', {}, 'c1', 409);
    expect(ticketTypeDeleteErrorMessage(err)).toBe('It has sales or holds.');
  });

  it('is what the tickets page shows when a delete fails', () => {
    const src = readFileSync(
      join(__dirname, '..', 'app/organizer/events/[id]/tickets/page.tsx'),
      'utf8',
    );
    expect(src).toContain('ticketTypeDeleteErrorMessage(e)');
  });
});
