import { FeedbackKind, NotificationType } from '@eticketsgo/shared-types';
import {
  ACK_LIMIT_PER_HOUR,
  SupportMailService,
  isUndeliverableDomain,
  type SupportMailInput,
} from './support-mail.service';
import { SupportService } from './support.service';
import type { RequestUser } from '../common/decorators';

/**
 * A support-form message reaches the support mailbox, and its sender is told it arrived.
 *
 * The defect: `SupportService.submit()` stored the row and did nothing else. The owner wrote in
 * through the live Contact page; the message sat OPEN in the admin console, no mail reached
 * support@eticketsgo.com, and the sender heard nothing.
 */

function config(values: Record<string, string | undefined>) {
  return { get: (key: string) => values[key] } as never;
}

function setup(env: Record<string, string | undefined>, ackCount = 0) {
  const send = jest.fn().mockResolvedValue(undefined);
  const notifications = { send } as never;
  const mail = new SupportMailService(notifications, config(env));
  const tx = { notification: { count: jest.fn().mockResolvedValue(ackCount) } };
  return { mail, send, tx };
}

const base: SupportMailInput = {
  feedbackId: 'fb-123',
  reference: 'ETG-SUP-2026-000142',
  kind: FeedbackKind.CONTACT,
  replyTo: 'asha@gmail.com',
  senderName: 'Asha Rao',
  accountEmail: null,
  userId: null,
  organizationName: null,
  bookingReference: null,
  topic: '[Support] Website enquiry',
  message: 'I was charged twice.',
  locale: 'fr-CA',
};

const inboxCall = (send: jest.Mock) =>
  send.mock.calls.find(([input]) => input.type === NotificationType.SUPPORT_REQUEST_RECEIVED);
const ackCall = (send: jest.Mock) =>
  send.mock.calls.find(([input]) => input.type === NotificationType.SUPPORT_REQUEST_ACKNOWLEDGED);

describe('SupportMailService.queue', () => {
  it('in production, mails the published support address with Reply-To the sender, and acks', async () => {
    const { mail, send, tx } = setup({ APP_ENV: 'PRODUCTION', ADMIN_WEB_URL: 'https://admin.x' });
    await mail.queue(tx as never, base);

    expect(send).toHaveBeenCalledTimes(2);
    const [inbox, inboxTx] = inboxCall(send)!;
    // Inside the submission's transaction, so the message and its mail commit together.
    expect(inboxTx).toBe(tx);
    expect(inbox).toEqual(
      expect.objectContaining({
        toEmail: 'support@eticketsgo.com',
        userId: null,
        channels: ['email'],
        locale: 'en',
        intentKey: 'support-request:fb-123',
      }),
    );
    expect(inbox.payload).toEqual(
      expect.objectContaining({
        replyTo: 'asha@gmail.com',
        senderName: 'Asha Rao',
        kind: 'CONTACT',
        topic: '[Support] Website enquiry',
        message: 'I was charged twice.',
        // The readable reference, never the database id; the id rides along for tracing only.
        reference: 'ETG-SUP-2026-000142',
        feedbackId: 'fb-123',
        link: 'https://admin.x/admin/support?q=ETG-SUP-2026-000142',
      }),
    );

    const [ack] = ackCall(send)!;
    expect(ack).toEqual(
      expect.objectContaining({
        toEmail: 'asha@gmail.com',
        channels: ['email'],
        locale: 'fr-CA',
        intentKey: 'support-request:fb-123',
      }),
    );
    // A reply to the acknowledgement reaches support; none of the message is repeated to it.
    expect(ack.payload).toEqual({
      reference: 'ETG-SUP-2026-000142',
      feedbackId: 'fb-123',
      email: 'asha@gmail.com',
      replyTo: 'support@eticketsgo.com',
    });
  });

  it('a row from before readable references is quoted, and linked, by its id as before', async () => {
    const { mail, send, tx } = setup({ APP_ENV: 'PRODUCTION', ADMIN_WEB_URL: 'https://admin.x' });
    await mail.queue(tx as never, { ...base, reference: null });
    expect(inboxCall(send)![0].payload).toEqual(
      expect.objectContaining({
        reference: 'fb-123',
        link: 'https://admin.x/admin/support?q=fb-123',
      }),
    );
    expect(ackCall(send)![0].payload.reference).toBe('fb-123');
  });

  it('outside production, mails NO support inbox unless SUPPORT_INBOX_EMAIL names one', async () => {
    for (const appEnv of ['LOCAL', 'DEV', 'QA', 'UAT', 'STAGING']) {
      const { mail, send, tx } = setup({ APP_ENV: appEnv });
      await mail.queue(tx as never, base);
      expect(inboxCall(send)).toBeUndefined();
      // The sender is still told: acknowledgements go wherever email is enabled.
      expect(ackCall(send)?.[0].toEmail).toBe('asha@gmail.com');
      expect(ackCall(send)?.[0].payload.replyTo).toBeUndefined();
    }
  });

  it('SUPPORT_INBOX_EMAIL is used when set, in any environment', async () => {
    const { mail, send, tx } = setup({
      APP_ENV: 'QA',
      SUPPORT_INBOX_EMAIL: ' QA-Inbox@Example.org ',
    });
    await mail.queue(tx as never, base);
    expect(inboxCall(send)?.[0].toEmail).toBe('qa-inbox@example.org');

    const prod = setup({ APP_ENV: 'PRODUCTION', SUPPORT_INBOX_EMAIL: 'ops@eticketsgo.com' });
    await prod.mail.queue(prod.tx as never, base);
    expect(inboxCall(prod.send)?.[0].toEmail).toBe('ops@eticketsgo.com');
  });

  it('a malformed SUPPORT_INBOX_EMAIL is ignored, never used as a header', async () => {
    const qa = setup({ APP_ENV: 'QA', SUPPORT_INBOX_EMAIL: 'a@b.com, evil@x.com' });
    await qa.mail.queue(qa.tx as never, base);
    expect(inboxCall(qa.send)).toBeUndefined();

    // In production the published address still applies.
    const prod = setup({ APP_ENV: 'PRODUCTION', SUPPORT_INBOX_EMAIL: 'not an address' });
    await prod.mail.queue(prod.tx as never, base);
    expect(inboxCall(prod.send)?.[0].toEmail).toBe('support@eticketsgo.com');
  });

  it('a sender address that could carry a second header gets no Reply-To and no ack', async () => {
    const { mail, send, tx } = setup({ APP_ENV: 'PRODUCTION' });
    await mail.queue(tx as never, {
      ...base,
      replyTo: 'asha@gmail.com\r\nBcc: victim@gmail.com',
    });
    expect(inboxCall(send)?.[0].payload.replyTo).toBe('');
    expect(ackCall(send)).toBeUndefined();
  });

  it('ratings and the feedback widget are not mailed at all', async () => {
    for (const kind of [FeedbackKind.CSAT, FeedbackKind.ORGANIZER_CSAT, FeedbackKind.GENERAL]) {
      const { mail, send, tx } = setup({ APP_ENV: 'PRODUCTION' });
      await mail.queue(tx as never, { ...base, kind });
      expect(send).not.toHaveBeenCalled();
    }
  });

  it('complaints, bug reports and feature requests are mailed like contact messages', async () => {
    for (const kind of [FeedbackKind.COMPLAINT, FeedbackKind.BUG, FeedbackKind.FEATURE]) {
      const { mail, send, tx } = setup({ APP_ENV: 'PRODUCTION' });
      await mail.queue(tx as never, { ...base, kind });
      expect(inboxCall(send)?.[0].payload.kind).toBe(kind);
      expect(ackCall(send)).toBeDefined();
    }
  });

  it('caps the acknowledgements one address can be sent in an hour', async () => {
    const { mail, send, tx } = setup({ APP_ENV: 'PRODUCTION' }, ACK_LIMIT_PER_HOUR);
    await mail.queue(tx as never, base);
    // The message still reaches support; only the "we have it" reply is withheld.
    expect(inboxCall(send)).toBeDefined();
    expect(ackCall(send)).toBeUndefined();
  });

  it('never acknowledges to a test domain, which could only bounce', async () => {
    for (const replyTo of ['me@eticketsgo.test', 'x@test.invalid', 'a@example.com']) {
      const { mail, send, tx } = setup({ APP_ENV: 'PRODUCTION' });
      await mail.queue(tx as never, { ...base, replyTo });
      expect(inboxCall(send)?.[0].payload.replyTo).toBe(replyTo);
      expect(ackCall(send)).toBeUndefined();
    }
    expect(isUndeliverableDomain('someone@gmail.com')).toBe(false);
  });

  it('caps the message the mailbox copy carries, and says it was shortened', async () => {
    const { mail, send, tx } = setup({ APP_ENV: 'PRODUCTION' });
    await mail.queue(tx as never, { ...base, message: 'x'.repeat(4000) });
    const payload = inboxCall(send)![0].payload;
    expect(payload.message).toHaveLength(3000);
    expect(payload.truncated).toBe(true);
  });

  it('an unknown form locale falls back to the account or English, never refused', async () => {
    const { mail, send, tx } = setup({ APP_ENV: 'PRODUCTION' });
    await mail.queue(tx as never, { ...base, locale: 'xx-YY' });
    expect(ackCall(send)?.[0].locale).toBeUndefined();
  });
});

describe('SupportService.submit queues the mails', () => {
  function service(env: Record<string, string | undefined>, repeat: unknown = null) {
    const send = jest.fn().mockResolvedValue(undefined);
    const mail = new SupportMailService({ send } as never, config(env));
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const prisma: any = {
      feedback: {
        create: jest.fn().mockResolvedValue({ id: 'fb-9', status: 'OPEN' }),
        findFirst: jest.fn().mockResolvedValue(repeat),
      },
      booking: {
        findUnique: jest
          .fn()
          .mockResolvedValue({ id: 'bk-1', organizationId: 'org-1', reference: 'ETG-IND-1' }),
      },
      organization: { findUnique: jest.fn().mockResolvedValue({ name: 'Bengaluru Live' }) },
      organizationMember: { findUnique: jest.fn().mockResolvedValue(null) },
      notification: { count: jest.fn().mockResolvedValue(0) },
      $executeRaw: jest.fn().mockResolvedValue(1),
      // The support reference counter (etg_next_reference_value): next number 142.
      $queryRaw: jest.fn().mockResolvedValue([{ value: 142 }]),
      $transaction: jest.fn((fn: (tx: unknown) => unknown) => fn(prisma)),
    };
    return { svc: new SupportService(prisma, undefined, mail), prisma, send };
  }

  const signedIn: RequestUser = {
    id: 'u1',
    email: 'owner@bengalurulive.in',
    fullName: 'Ravi Kumar',
    roles: [],
  };

  it('a signed-in complaint mails support with the account, organizer and booking named', async () => {
    const { svc, send } = service({ APP_ENV: 'PRODUCTION' });
    const res = await svc.submit(signedIn, {
      kind: FeedbackKind.COMPLAINT,
      message: 'The show started an hour late.',
      bookingId: 'bk-1',
    });
    expect(res).toEqual({ id: 'fb-9', status: 'OPEN' });
    const [inbox] = inboxCall(send)!;
    expect(inbox.toEmail).toBe('support@eticketsgo.com');
    expect(inbox.payload).toEqual(
      expect.objectContaining({
        replyTo: 'owner@bengalurulive.in',
        senderName: 'Ravi Kumar',
        accountEmail: 'owner@bengalurulive.in',
        organizationName: 'Bengaluru Live',
        bookingReference: 'ETG-IND-1',
      }),
    );
    const [ack] = ackCall(send)!;
    expect(ack.toEmail).toBe('owner@bengalurulive.in');
    expect(ack.userId).toBe('u1');
  });

  it('the same message sent again returns the first submission and mails nothing more', async () => {
    const { svc, prisma, send } = service(
      { APP_ENV: 'PRODUCTION' },
      { id: 'fb-1', status: 'OPEN' },
    );
    const res = await svc.submit(undefined, {
      kind: FeedbackKind.CONTACT,
      email: 'asha@gmail.com',
      message: 'Hello',
    });
    expect(res).toEqual({ id: 'fb-1', status: 'OPEN' });
    expect(prisma.feedback.create).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
    // The check and the insert are serialised on a lock named after the message.
    expect(prisma.$executeRaw).toHaveBeenCalled();
  });

  it('a form name wins over the account name for the From line', async () => {
    const { svc, send } = service({ APP_ENV: 'PRODUCTION' });
    await svc.submit(undefined, {
      kind: FeedbackKind.CONTACT,
      email: 'asha@gmail.com',
      name: 'Asha Rao',
      message: 'Hello',
    });
    expect(inboxCall(send)![0].payload.senderName).toBe('Asha Rao');
  });
});
