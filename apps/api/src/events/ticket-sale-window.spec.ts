import { ticketSaleWindow } from './public-events.service';

/*
  The public event payload used to say nothing about a ticket type's sales window, so the
  storefront offered a closed tier ("10 left") and the booking path refused it at the last step
  with "is not currently on sale". Reproduced on QA 2026-10-12 with a tier whose sales ended an
  hour earlier. This pins the same test the booking path applies (bookings.service).
*/
describe('ticketSaleWindow', () => {
  const now = new Date('2026-10-12T10:00:00Z');
  const hour = 3_600_000;

  it('is on sale with no window at all', () => {
    expect(ticketSaleWindow(null, null, now)).toEqual({ saleState: 'ON_SALE', salesStartAt: null });
  });

  it('is closed once the end has passed', () => {
    expect(ticketSaleWindow(null, new Date(now.getTime() - hour), now).saleState).toBe('CLOSED');
  });

  it('is not yet on sale before the start, and says when it opens', () => {
    const start = new Date(now.getTime() + hour);
    expect(ticketSaleWindow(start, null, now)).toEqual({
      saleState: 'NOT_YET',
      salesStartAt: start.toISOString(),
    });
  });

  it('is on sale inside the window', () => {
    const r = ticketSaleWindow(new Date(now.getTime() - hour), new Date(now.getTime() + hour), now);
    expect(r.saleState).toBe('ON_SALE');
  });
});
