import { EventsService } from './events.service';

/**
 * Retiring what is over.
 *
 * ── THE DEFECT THESE PIN ───────────────────────────────────────────────────────────
 * The worker moved the EVENT to COMPLETED when its last session had ended and never touched
 * the sessions, and nothing else did either. So an organizer opened an event badged
 * COMPLETED and found its one session marked SCHEDULED underneath it — the same page
 * contradicting itself about the same show, which is how a console stops being believed.
 *
 * It was not only cosmetic. Two places on the booking path carry comments explaining that
 * "nothing marks a session COMPLETED" and check the clock instead. Those checks stay —
 * a session stops being sellable when it STARTS and is only over when it ENDS — but they are
 * no longer the only thing between a stale page and a ticket to last Tuesday.
 */
describe('EventsService.completePastEvents', () => {
  const HOUR = 60 * 60 * 1000;
  const past = (h: number) => new Date(Date.now() - h * HOUR);

  function makeService(events: { id: string; lastEndsAt: Date }[] = []) {
    const sessionUpdateMany = jest.fn().mockResolvedValue({ count: 0 });
    const eventUpdateMany = jest.fn().mockResolvedValue({ count: 0 });
    const prisma = {
      eventSession: { updateMany: sessionUpdateMany },
      event: {
        findMany: jest
          .fn()
          .mockResolvedValue(
            events.map((e) => ({ id: e.id, sessions: [{ endsAt: e.lastEndsAt }] })),
          ),
        updateMany: eventUpdateMany,
      },
    };
    const service = new EventsService(
      prisma as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
    );
    return { service, sessionUpdateMany, eventUpdateMany };
  }

  it('retires every session that has ended, whatever its event is doing', async () => {
    const { service, sessionUpdateMany } = makeService();

    await service.completePastEvents();

    const [call] = sessionUpdateMany.mock.calls;
    expect(call[0].data).toEqual({ status: 'COMPLETED' });
    /*
      Independent of the event on purpose. A multi-date run is the case theatres and cinemas
      exist to sell: the dates that have been and gone must read COMPLETED while the run
      itself is still PUBLISHED and still selling the rest of them.
    */
    expect(call[0].where.event).toBeUndefined();
  });

  it('waits for a show to END, not to start', async () => {
    // Marking it at the start would retire a session while the audience is still inside it
    // and the gate is still scanning tickets against it.
    const { service, sessionUpdateMany } = makeService();

    await service.completePastEvents();

    const where = sessionUpdateMany.mock.calls[0][0].where;
    expect(where.endsAt).toBeDefined();
    expect(where.startsAt).toBeUndefined();
    expect(where.endsAt.lt).toBeInstanceOf(Date);
  });

  it('never rewrites a cancelled show as a completed one', async () => {
    /*
      A different outcome, and a permanent one. Calling a cancelled date "completed" erases
      the reason a refund was owed, and the organizer's own record of what happened.
    */
    const { service, sessionUpdateMany } = makeService();

    await service.completePastEvents();

    expect(sessionUpdateMany.mock.calls[0][0].where.status).toEqual({
      in: ['SCHEDULED', 'PAUSED'],
    });
  });

  it('still retires an event once its last session has ended', async () => {
    const { service, eventUpdateMany } = makeService([{ id: 'over', lastEndsAt: past(3) }]);

    const completed = await service.completePastEvents();

    expect(completed).toBe(1);
    expect(eventUpdateMany).toHaveBeenCalledWith({
      where: { id: { in: ['over'] } },
      data: { status: 'COMPLETED' },
    });
  });

  it('leaves an event alone while it still has a date to come', async () => {
    const { service, eventUpdateMany } = makeService([
      { id: 'running', lastEndsAt: new Date(Date.now() + 48 * HOUR) },
    ]);

    expect(await service.completePastEvents()).toBe(0);
    expect(eventUpdateMany).not.toHaveBeenCalled();
  });

  it('sweeps the sessions even when no event is due to be retired', async () => {
    // The early return for "no events to complete" must not skip the session sweep, or a
    // past date inside a still-running run would keep saying SCHEDULED for ever.
    const { service, sessionUpdateMany } = makeService([
      { id: 'running', lastEndsAt: new Date(Date.now() + 48 * HOUR) },
    ]);

    await service.completePastEvents();

    expect(sessionUpdateMany).toHaveBeenCalledTimes(1);
  });
});
