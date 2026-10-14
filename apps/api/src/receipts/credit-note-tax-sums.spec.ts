import { ReceiptsService } from './receipts.service';
import { refundTaxForTickets, ticketNetPrices } from '../refunds/refund-tax';

/**
 * Credit notes for a booking's partial refunds add back up to the tax on its sale.
 *
 * A booking of five tickets with GST inside the price (CGST + SGST on the tickets) and GST
 * added to the fee (IGST). Refunded in three pieces, the credit notes must state, line by
 * line, exactly the ticket tax the sale receipt stated - not a paisa either way - and each
 * credit note's own lines must add up to its own tax total.
 */
const booking = {
  id: 'b1',
  organizationId: 'org-1',
  currency: 'INR',
  reference: 'ETG-IND-2026-000045',
  buyerName: 'Ada',
  buyerEmail: 'ada@example.test',
  subtotalMinor: 5 * 33_333,
  discountMinor: 0,
  customerFeeMinor: 3_527,
  taxMinor: 0,
  items: [{ id: 'i1', ticketTypeId: 't1', addOnId: null, unitPriceMinor: 33_333, quantity: 5 }],
  taxLines: [
    // 166,665 at 18% inclusive: taxable 141,242, levy 25,423 -> 12,712 + 12,711.
    {
      label: 'CGST',
      rateBasisPoints: 900,
      baseMinor: 141_242,
      amountMinor: 12_712,
      basis: 'TICKETS',
      inclusive: true,
    },
    {
      label: 'SGST',
      rateBasisPoints: 900,
      baseMinor: 141_242,
      amountMinor: 12_711,
      basis: 'TICKETS',
      inclusive: true,
    },
    {
      label: 'IGST',
      rateBasisPoints: 1800,
      baseMinor: 3_527,
      amountMinor: 635,
      basis: 'FEES',
      inclusive: false,
    },
  ],
};
booking.taxMinor = booking.taxLines.reduce((s, l) => s + l.amountMinor, 0);
const TICKETS = ['tk1', 'tk2', 'tk3', 'tk4', 'tk5'].map((id) => ({ id, ticketTypeId: 't1' }));

function issue(refund: Record<string, unknown>) {
  const create = jest.fn().mockResolvedValue({});
  const tx = {
    refund: {
      findUnique: jest.fn().mockResolvedValue({ ...refund, booking, creditNote: null }),
    },
    organization: {
      findUnique: jest.fn().mockResolvedValue({
        name: 'Cinema',
        legalName: null,
        taxRegistrationKind: null,
        taxRegistrationNumber: null,
        registeredAddressLine1: null,
        registeredAddressLine2: null,
        registeredCity: null,
        registeredRegion: null,
        registeredPostalCode: null,
        registeredCountry: null,
        financeContactName: null,
        financeContactEmail: null,
        financeContactPhone: null,
      }),
    },
    receipt: { findUnique: jest.fn().mockResolvedValue(null), create },
    receiptCounter: { upsert: jest.fn().mockResolvedValue({ value: 1 }) },
    ticket: { findMany: jest.fn().mockResolvedValue(TICKETS) },
  };
  return new ReceiptsService({} as never).issueCreditNote(tx as never, refund.id as string).then(
    () =>
      create.mock.calls[0][0].data as {
        taxMinor: number;
        documentJson: { taxLines: { label: string; amountMinor: number }[] };
      },
  );
}

/** A refund row as the refund service would write it for these tickets. */
function refundFor(id: string, ticketIds: string[], cancellation = false) {
  const { netByTicket, bookingTicketsMinor } = ticketNetPrices(booking.items, TICKETS, booking);
  const tax = refundTaxForTickets(booking.taxLines, netByTicket, ticketIds, bookingTicketsMinor, {
    includeFeeTax: cancellation,
  });
  const ticketsMinor = ticketIds.reduce((s, t) => s + (netByTicket.get(t) ?? 0), 0);
  const fees = cancellation ? booking.customerFeeMinor : 0;
  return {
    id,
    amountMinor: ticketsMinor + fees + tax.addedMinor,
    taxMinor: tax.taxMinor,
    taxAddedMinor: tax.addedMinor,
    platformFeeRefundedMinor: fees,
    reason: 'changed my mind',
    ticketIds,
  };
}

describe('credit notes for partial refunds', () => {
  it('state, between them, exactly the ticket tax the sale stated', async () => {
    const notes = await Promise.all([
      issue(refundFor('r1', ['tk1'])),
      issue(refundFor('r2', ['tk4', 'tk2'])),
      issue(refundFor('r3', ['tk3', 'tk5'])),
    ]);
    for (const label of ['CGST', 'SGST']) {
      const stated = notes.reduce(
        (s, n) => s + n.documentJson.taxLines.find((l) => l.label === label)!.amountMinor,
        0,
      );
      // Negative on a credit note: it reverses the sale.
      expect(-stated).toBe(booking.taxLines.find((l) => l.label === label)!.amountMinor);
    }
    for (const n of notes) {
      expect(n.documentJson.taxLines.reduce((s, l) => s + l.amountMinor, 0)).toBe(n.taxMinor);
    }
  });

  it('on a cancellation, list the fee tax that went back, so the note adds up', async () => {
    const note = await issue(refundFor('r4', ['tk1', 'tk2', 'tk3', 'tk4', 'tk5'], true));
    expect(note.documentJson.taxLines.map((l) => l.label)).toEqual(['CGST', 'SGST', 'IGST']);
    expect(note.documentJson.taxLines.reduce((s, l) => s + l.amountMinor, 0)).toBe(note.taxMinor);
    expect(-note.taxMinor).toBe(booking.taxMinor);
  });
});
