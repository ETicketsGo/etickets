import { NotificationsController } from './notifications.controller';
import type { RequestUser } from '../common/decorators';

/**
 * The parameter that was parsed and then thrown away.
 *
 * ── WHY A CONTROLLER TEST, WHICH THIS FILE DID NOT HAVE ────────────────────────────
 * `message-audience.spec.ts` proves an event approval belongs to the ORGANIZER. The service
 * spec proves the query filters on it. The customer site asks for `audience=CUSTOMER`. Every
 * one of those passed while an organizer looked at their customer inbox and saw "EV-1 is
 * approved" — because the controller validated the parameter and then called the service
 * without it.
 *
 * Nothing failed, and nothing could: a query parameter the server ignores looks exactly like
 * one the server honours, unless you are the person who holds both roles. The join between
 * the two halves was the only thing untested, so it was the only thing broken — and it was
 * broken AFTER the feature was built and reported fixed, which is what made it a regression
 * rather than a gap.
 *
 * These assert the wiring itself: what the controller received is what the service was told.
 */
describe('the notifications controller forwards the audience it was given', () => {
  const user = { id: 'u1', email: 'a@b.test', fullName: 'A', roles: [] } as RequestUser;

  const spies = () => ({
    inbox: jest.fn().mockResolvedValue({ items: [], unreadCount: 0 }),
    unreadCount: jest.fn().mockResolvedValue(3),
    markRead: jest.fn().mockResolvedValue(true),
    markAllRead: jest.fn().mockResolvedValue(2),
  });

  it('passes the requested stream to the inbox query', async () => {
    const service = spies();
    const controller = new NotificationsController(service as never);

    await controller.inbox(user, { limit: 50, audience: 'CUSTOMER' });

    expect(service.inbox).toHaveBeenCalledWith('u1', {
      limit: 50,
      before: undefined,
      audience: 'CUSTOMER',
    });
  });

  it.each(['CUSTOMER', 'ORGANIZER', 'ADMIN'] as const)(
    'forwards %s unchanged',
    async (audience) => {
      const service = spies();
      const controller = new NotificationsController(service as never);

      await controller.inbox(user, { audience });

      expect(service.inbox).toHaveBeenCalledWith('u1', expect.objectContaining({ audience }));
    },
  );

  it('scopes the unread count, so one site’s bell cannot count the other’s messages', async () => {
    const service = spies();
    const controller = new NotificationsController(service as never);

    await controller.unreadCount(user, { audience: 'CUSTOMER' });

    expect(service.unreadCount).toHaveBeenCalledWith('u1', 'CUSTOMER');
  });

  it('scopes mark-all-read, which is the one that destroys rather than misplaces', async () => {
    /*
      An unscoped "mark all read" on the customer site silences an organizer's payout notices
      on a screen they were not even looking at. Showing the wrong thing is recoverable;
      clearing a signal somebody needed is not.
    */
    const service = spies();
    const controller = new NotificationsController(service as never);

    await controller.markAllRead(user, { audience: 'CUSTOMER' });

    expect(service.markAllRead).toHaveBeenCalledWith('u1', 'CUSTOMER');
  });

  it('still answers a caller that names no stream', async () => {
    // The HTTP contract keeps `audience` optional: an unknown client is better served
    // everything than nothing. Only the in-repo TypeScript client makes it mandatory.
    const service = spies();
    const controller = new NotificationsController(service as never);

    await controller.inbox(user, {});

    expect(service.inbox).toHaveBeenCalledWith(
      'u1',
      expect.objectContaining({ audience: undefined }),
    );
  });
});
