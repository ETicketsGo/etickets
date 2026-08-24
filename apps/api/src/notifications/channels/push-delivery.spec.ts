import { PushChannel } from './push.channel';
import { ExpoPushTransport, isExpoPushToken } from './transports/push.transport';
import type { RenderedNotification } from './notification-channel.interface';

/**
 * Whether a push notification can actually reach a phone.
 *
 * ── WHAT WAS BROKEN ───────────────────────────────────────────────────────────────
 * Two halves that were never introduced. The mobile app registered devices and rows
 * accumulated in `UserDevice`; the push channel sent only to `payload.pushToken(s)`, which
 * no caller ever supplied. And the one real transport was FCM, which cannot deliver to the
 * `ExponentPushToken[...]` the app produces.
 *
 * So registration succeeded, tokens were stored, and not one push could have arrived. The
 * successful registration is exactly what made it look finished.
 */
const msg = (over: Partial<RenderedNotification> = {}): RenderedNotification =>
  ({
    type: 'BOOKING_CONFIRMED',
    userId: 'u1',
    subject: 'Your booking is confirmed',
    body: 'Booking bk_1 is confirmed.',
    payload: {},
    ...over,
  }) as RenderedNotification;

const prismaWith = (tokens: string[], onQuery?: (args: unknown) => void) =>
  ({
    userDevice: {
      findMany: jest.fn(async (args: unknown) => {
        onQuery?.(args);
        return tokens.map((token) => ({ token }));
      }),
    },
  }) as never;

describe('the push channel finds the recipient’s devices', () => {
  it('sends to registered devices even when the caller passes no token', async () => {
    // The defect, stated as a test: this used to deliver to nobody.
    const transport = { send: jest.fn().mockResolvedValue(undefined) };
    const channel = new PushChannel(transport, undefined, prismaWith(['ExponentPushToken[aaa]']));

    await channel.deliver(msg());

    expect(transport.send).toHaveBeenCalledTimes(1);
    expect(transport.send.mock.calls[0][0].payload.pushTokens).toEqual(['ExponentPushToken[aaa]']);
  });

  it('excludes devices whose OS permission was denied', async () => {
    const seen: unknown[] = [];
    const transport = { send: jest.fn().mockResolvedValue(undefined) };
    const channel = new PushChannel(
      transport,
      undefined,
      prismaWith(['t1'], (a) => seen.push(a)),
    );

    await channel.deliver(msg());

    // Sending to a denied device is guaranteed waste, and Expo answers DeviceNotRegistered.
    expect((seen[0] as { where: { permissionStatus: unknown } }).where.permissionStatus).toEqual({
      not: 'denied',
    });
  });

  it('merges caller-supplied tokens with registered ones, without duplicates', async () => {
    // A caller may still address a specific device, or a recipient with no account. Both
    // sources are honoured so nothing that worked before changes.
    const transport = { send: jest.fn().mockResolvedValue(undefined) };
    const channel = new PushChannel(transport, undefined, prismaWith(['shared', 'device-only']));

    await channel.deliver(msg({ payload: { pushTokens: ['caller-only', 'shared'] } }));

    expect([...transport.send.mock.calls[0][0].payload.pushTokens].sort()).toEqual([
      'caller-only',
      'device-only',
      'shared',
    ]);
  });

  it('still delivers when there is no user or no database', async () => {
    // The channel is a default for every notification; it must degrade, never block.
    const transport = { send: jest.fn().mockResolvedValue(undefined) };
    await new PushChannel(transport, undefined, undefined).deliver(msg());
    await new PushChannel(transport, undefined, prismaWith([])).deliver(msg({ userId: null }));
    expect(transport.send).toHaveBeenCalledTimes(2);
  });

  it('a device lookup failure does not lose the notification', async () => {
    /*
      The same notification is also written to the in-app inbox and emailed. Throwing here
      would fail the whole send and trigger a retry of all three channels over a database
      hiccup on the least important one.
    */
    const transport = { send: jest.fn().mockResolvedValue(undefined) };
    const prisma = {
      userDevice: { findMany: jest.fn().mockRejectedValue(new Error('db down')) },
    } as never;

    await expect(
      new PushChannel(transport, undefined, prisma).deliver(msg()),
    ).resolves.not.toThrow();
    expect(transport.send).toHaveBeenCalledTimes(1);
  });
});

describe('recognising an Expo token', () => {
  it('accepts what the app actually produces', () => {
    expect(isExpoPushToken('ExponentPushToken[xxxxxxxxxxxxxxxxxxxxxx]')).toBe(true);
    expect(isExpoPushToken('ExpoPushToken[xxxxxxxxxxxxxxxxxxxxxx]')).toBe(true);
  });

  it('rejects an FCM registration id', () => {
    // Sending one of these to Expo — or an Expo token to FCM — is the mismatch that made
    // push undeliverable. The token decides the transport.
    expect(isExpoPushToken('fMEP0vJqSXY:APA91bH...')).toBe(false);
    expect(isExpoPushToken('')).toBe(false);
  });
});

describe('the Expo transport', () => {
  const config = { get: () => undefined } as never;
  const okResponse = { ok: true, json: async () => ({ data: [{ status: 'ok' }] }) };

  afterEach(() => jest.restoreAllMocks());

  it('posts the notification to Expo for each registered token', async () => {
    const fetchMock = jest.fn().mockResolvedValue(okResponse);
    global.fetch = fetchMock as never;

    await new ExpoPushTransport(config).send(
      msg({ payload: { pushTokens: ['ExponentPushToken[a]', 'ExponentPushToken[b]'] } }),
    );

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body).toHaveLength(2);
    expect(body[0]).toMatchObject({
      to: 'ExponentPushToken[a]',
      title: 'Your booking is confirmed',
    });
    // The app routes on `type`; it must survive into the data payload.
    expect(body[0].data.type).toBe('BOOKING_CONFIRMED');
  });

  it('skips non-Expo tokens rather than sending them somewhere they cannot work', async () => {
    const fetchMock = jest.fn().mockResolvedValue(okResponse);
    global.fetch = fetchMock as never;

    await new ExpoPushTransport(config).send(
      msg({ payload: { pushTokens: ['fcm-token-here', 'ExponentPushToken[a]'] } }),
    );

    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body.map((m: { to: string }) => m.to)).toEqual(['ExponentPushToken[a]']);
  });

  it('does nothing at all when there is no Expo token', async () => {
    const fetchMock = jest.fn();
    global.fetch = fetchMock as never;
    await new ExpoPushTransport(config).send(msg({ payload: {} }));
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('chunks at 100, which is Expo’s request limit', async () => {
    const fetchMock = jest.fn().mockResolvedValue(okResponse);
    global.fetch = fetchMock as never;
    const tokens = Array.from({ length: 250 }, (_, i) => `ExponentPushToken[${i}]`);

    await new ExpoPushTransport(config).send(msg({ payload: { pushTokens: tokens } }));

    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toHaveLength(100);
    expect(JSON.parse(fetchMock.mock.calls[2][1].body)).toHaveLength(50);
  });

  it('THROWS on a transport failure, so the retry machinery runs', async () => {
    // An outage or a bad access token is worth retrying.
    global.fetch = jest.fn().mockResolvedValue({ ok: false, status: 503 }) as never;
    await expect(
      new ExpoPushTransport(config).send(
        msg({ payload: { pushTokens: ['ExponentPushToken[a]'] } }),
      ),
    ).rejects.toThrow(/503/);
  });

  it('does NOT throw when one device is rejected', async () => {
    /*
      A per-device error — the app uninstalled, a token from another project — must not fail
      the batch. Retrying would re-deliver to every healthy device alongside it.
    */
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        data: [{ status: 'ok' }, { status: 'error', message: 'DeviceNotRegistered' }],
      }),
    }) as never;

    await expect(
      new ExpoPushTransport(config).send(
        msg({ payload: { pushTokens: ['ExponentPushToken[a]', 'ExponentPushToken[b]'] } }),
      ),
    ).resolves.not.toThrow();
  });

  it('sends an access token only when one is configured', async () => {
    const fetchMock = jest.fn().mockResolvedValue(okResponse);
    global.fetch = fetchMock as never;

    // Ordinary sends need no credential: the device token authorises delivery. The header
    // is only required once "enhanced security" is switched on in the Expo dashboard.
    await new ExpoPushTransport(config).send(
      msg({ payload: { pushTokens: ['ExponentPushToken[a]'] } }),
    );
    expect(fetchMock.mock.calls[0][1].headers.authorization).toBeUndefined();

    const withToken = { get: (k: string) => (k === 'EXPO_ACCESS_TOKEN' ? 'secret' : undefined) };
    await new ExpoPushTransport(withToken as never).send(
      msg({ payload: { pushTokens: ['ExponentPushToken[a]'] } }),
    );
    expect(fetchMock.mock.calls[1][1].headers.authorization).toBe('Bearer secret');
  });
});
