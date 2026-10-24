import { ticketCount } from '../schema';

describe('ticketCount', () => {
  it('counts what was ordered, so an unpaid booking is not "0 tickets"', () => {
    expect(ticketCount({ items: [{ kind: 'TICKET', quantity: 2 }], tickets: [] })).toBe(2);
  });

  it('leaves add-ons out', () => {
    expect(
      ticketCount({
        items: [
          { kind: 'TICKET', quantity: 1 },
          { kind: 'ADD_ON', quantity: 3 },
        ],
        tickets: [{ id: 't1' }],
      }),
    ).toBe(1);
  });

  it('falls back to the issued tickets when no order lines are sent', () => {
    expect(ticketCount({ items: undefined, tickets: [{ id: 'a' }, { id: 'b' }] })).toBe(2);
  });
});
