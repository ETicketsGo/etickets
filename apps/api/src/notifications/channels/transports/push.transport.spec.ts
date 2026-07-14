import { ConfigService } from '@nestjs/config';
import { NotificationType } from '@eticketsgo/shared-types';
import { RenderedNotification } from '../notification-channel.interface';
import { FcmPushTransport, PushLogTransport, selectPushTransport } from './push.transport';

const mockSend = jest.fn().mockResolvedValue('projects/x/messages/1');
const mockSendEachForMulticast = jest
  .fn()
  .mockResolvedValue({ successCount: 1, failureCount: 0, responses: [{ success: true }] });

jest.mock('firebase-admin/app', () => ({
  getApps: jest.fn().mockReturnValue([]),
  initializeApp: jest.fn().mockReturnValue({ name: 'eticketsgo-notifications' }),
  cert: jest.fn().mockReturnValue({ __cred: true }),
}));
jest.mock('firebase-admin/messaging', () => ({
  // Lazy factory so the mock consts are read at call-time, after they init.
  getMessaging: jest.fn(() => ({
    send: mockSend,
    sendEachForMulticast: mockSendEachForMulticast,
  })),
}));

function configFor(values: Record<string, string | undefined>): ConfigService {
  return { get: (k: string) => values[k] } as unknown as ConfigService;
}

function msg(over: Partial<RenderedNotification> = {}): RenderedNotification {
  return {
    type: NotificationType.EVENT_REMINDER,
    channel: 'push',
    locale: 'en',
    toEmail: null,
    userId: 'u1',
    subject: 'Reminder',
    body: 'Your event is coming up.',
    payload: { pushToken: 'tok-abc' },
    ...over,
  };
}

const fcmConfig = configFor({
  FCM_PROJECT_ID: 'proj',
  FCM_CLIENT_EMAIL: 'sa@proj.iam.gserviceaccount.com',
  FCM_PRIVATE_KEY: '-----BEGIN PRIVATE KEY-----\\nabc\\n-----END PRIVATE KEY-----\\n',
});

beforeEach(() => jest.clearAllMocks());

describe('PushLogTransport (default)', () => {
  it('logs and never calls FCM', async () => {
    await new PushLogTransport().send(msg());
    expect(mockSend).not.toHaveBeenCalled();
    expect(mockSendEachForMulticast).not.toHaveBeenCalled();
  });
});

describe('FcmPushTransport', () => {
  it('sends to a single payload.pushToken with subject/body as the notification', async () => {
    await new FcmPushTransport(fcmConfig).send(msg());
    expect(mockSend).toHaveBeenCalledWith({
      token: 'tok-abc',
      notification: { title: 'Reminder', body: 'Your event is coming up.' },
    });
  });

  it('multicasts when payload.pushTokens holds several tokens', async () => {
    await new FcmPushTransport(fcmConfig).send(msg({ payload: { pushTokens: ['t1', 't2'] } }));
    expect(mockSendEachForMulticast).toHaveBeenCalledWith({
      tokens: ['t1', 't2'],
      notification: { title: 'Reminder', body: 'Your event is coming up.' },
    });
  });

  it('skips cleanly (no send, no throw) when no token is present', async () => {
    await expect(
      new FcmPushTransport(fcmConfig).send(msg({ payload: { bookingId: 'bk-1' } })),
    ).resolves.toBeUndefined();
    expect(mockSend).not.toHaveBeenCalled();
    expect(mockSendEachForMulticast).not.toHaveBeenCalled();
  });

  it('propagates a provider error so retry/FAILED handling runs', async () => {
    mockSend.mockRejectedValueOnce(new Error('fcm unavailable'));
    await expect(new FcmPushTransport(fcmConfig).send(msg())).rejects.toThrow('fcm unavailable');
  });

  it('throws when a multicast has failures', async () => {
    mockSendEachForMulticast.mockResolvedValueOnce({
      successCount: 1,
      failureCount: 1,
      responses: [{ success: true }, { success: false, error: { message: 'invalid token' } }],
    });
    await expect(
      new FcmPushTransport(fcmConfig).send(msg({ payload: { pushTokens: ['t1', 't2'] } })),
    ).rejects.toThrow(/invalid token/);
  });

  it('fails fast when FCM_PROJECT_ID is missing', () => {
    expect(() => new FcmPushTransport(configFor({ FCM_CLIENT_EMAIL: 'a@b' }))).toThrow(
      /FCM_PROJECT_ID/,
    );
  });
});

describe('selectPushTransport', () => {
  it('defaults to the log transport when PUSH_PROVIDER is unset', () => {
    expect(selectPushTransport(configFor({}))).toBeInstanceOf(PushLogTransport);
  });

  it('selects FCM when PUSH_PROVIDER=fcm', () => {
    const t = selectPushTransport(
      configFor({
        PUSH_PROVIDER: 'fcm',
        FCM_PROJECT_ID: 'p',
        FCM_CLIENT_EMAIL: 'a@b',
        FCM_PRIVATE_KEY: 'k',
      }),
    );
    expect(t).toBeInstanceOf(FcmPushTransport);
  });

  it('fails fast when FCM is selected without keys', () => {
    expect(() => selectPushTransport(configFor({ PUSH_PROVIDER: 'fcm' }))).toThrow(
      /FCM_PROJECT_ID/,
    );
  });
});
