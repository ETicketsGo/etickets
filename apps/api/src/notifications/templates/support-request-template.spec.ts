import { NotificationType } from '@eticketsgo/shared-types';
import { NotificationTemplateService } from './notification-template.service';
import { buildEmailView } from './email-view';
import { renderEmailHtml } from './email-html';

/**
 * The two support mails, as text and as HTML, in English and Canadian French.
 *
 * Rendered through the same three functions the worker calls, so what is asserted here is
 * what the support mailbox and the sender actually receive.
 */
const templates = new NotificationTemplateService();

function render(type: NotificationType, locale: string, payload: Record<string, unknown>) {
  const text = templates.render(type, locale, payload);
  const html = renderEmailHtml(
    buildEmailView({ type, locale, ...text, payload, helpUrl: 'https://qa.eticketsgo.com/help' }),
  );
  return { ...text, html };
}

const inboxPayload = {
  reference: 'cmg123',
  kind: 'CONTACT',
  topic: '[Support] Website enquiry',
  message:
    'From: Asha Rao\n\nCharged twice for ETG-IND-2026-000024.\nPlease check.\n\n' +
    '<script>alert(1)</script> see https://evil.example.com/login',
  senderName: 'Asha Rao',
  replyTo: 'asha@gmail.com',
  accountEmail: '',
  organizationName: 'Bengaluru Live',
  bookingReference: 'ETG-IND-2026-000024',
  link: 'https://admin-qa.eticketsgo.com/admin/support?q=cmg123',
};

describe('SUPPORT_REQUEST_RECEIVED (the support mailbox copy)', () => {
  it('en: names the kind, the sender, how to reply, every fact and the whole message', () => {
    const { subject, body, html } = render(
      NotificationType.SUPPORT_REQUEST_RECEIVED,
      'en',
      inboxPayload,
    );
    expect(subject).toBe('New contact message: [Support] Website enquiry');
    expect(body).toContain('New contact message from Asha Rao.');
    expect(body).toContain('Your reply goes to asha@gmail.com.');
    expect(body).toContain('Organizer: Bengaluru Live');
    expect(body).toContain('Booking: ETG-IND-2026-000024');
    expect(body).toContain('Reference: cmg123');
    expect(body).toContain('Signed in as: not signed in');
    expect(body).toContain('Charged twice for ETG-IND-2026-000024.\nPlease check.');
    expect(body).toContain(
      'Open it in the admin console: https://admin-qa.eticketsgo.com/admin/support?q=cmg123',
    );

    expect(html).toContain('Open in the admin console');
    expect(html).toContain('href="https://admin-qa.eticketsgo.com/admin/support?q=cmg123"');
    // Line breaks the sender typed are kept, and are the only markup in their words.
    expect(html).toContain('Charged twice for ETG-IND-2026-000024.<br />Please check.');
  });

  it('escapes what the sender typed and never makes their link our button', () => {
    const { html } = render(NotificationType.SUPPORT_REQUEST_RECEIVED, 'en', inboxPayload);
    expect(html).not.toContain('<script>');
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
    expect(html).not.toContain('href="https://evil.example.com');

    // With no admin URL configured there is no button at all - not one built from the message.
    const noLink = render(NotificationType.SUPPORT_REQUEST_RECEIVED, 'en', {
      ...inboxPayload,
      link: '',
    });
    expect(noLink.html).not.toContain('href="https://evil.example.com');
    expect(noLink.html).not.toContain('Open in the admin console');
  });

  it('a subject is one line, whatever the topic contains', () => {
    const { subject } = render(NotificationType.SUPPORT_REQUEST_RECEIVED, 'en', {
      ...inboxPayload,
      topic: 'Hello\r\nBcc: victim@gmail.com',
    });
    expect(subject).not.toMatch(/[\r\n]/);
  });

  it('says when a reply cannot reach the sender, and when the message was shortened', () => {
    const { body } = render(NotificationType.SUPPORT_REQUEST_RECEIVED, 'en', {
      ...inboxPayload,
      replyTo: '',
      senderName: '',
      topic: '',
      kind: 'COMPLAINT',
      truncated: true,
    });
    expect(body).toContain('New complaint message from someone.');
    expect(body).toContain('a reply to this email will not reach them');
    expect(body).toContain('This message was shortened for email.');
  });

  it('fr-CA renders from the French catalogue', () => {
    const { subject, body, html } = render(
      NotificationType.SUPPORT_REQUEST_RECEIVED,
      'fr-CA',
      inboxPayload,
    );
    expect(subject).toBe('Nouveau message (contact) : [Support] Website enquiry');
    expect(body).toContain('Votre réponse ira à asha@gmail.com.');
    expect(html).toContain('lang="fr-CA"');
    expect(html).toContain('Ouvrir dans la console d&#39;administration');
  });
});

describe('SUPPORT_REQUEST_ACKNOWLEDGED (to the sender)', () => {
  const payload = { reference: 'cmg123', email: 'asha@gmail.com' };

  it('en: says we have it, where we will reply, and the reference - and nothing they wrote', () => {
    const { subject, body, html } = render(
      NotificationType.SUPPORT_REQUEST_ACKNOWLEDGED,
      'en',
      payload,
    );
    expect(subject).toBe('We have your message');
    expect(body).toBe(
      'Thank you for writing to ETicketsGo. We have your message and we will reply to ' +
        'asha@gmail.com. Your reference is cmg123. If you write to us again about this, ' +
        'please give this reference.',
    );
    // Plain ASCII, as every new English line of copy is.
    expect(/^[\x20-\x7E]*$/.test(subject + body)).toBe(true);
    expect(html).toContain('because you wrote to ETicketsGo support');
    expect(html).not.toContain('Charged twice');
  });

  it('fr-CA: the same, in French', () => {
    const { subject, body } = render(
      NotificationType.SUPPORT_REQUEST_ACKNOWLEDGED,
      'fr-CA',
      payload,
    );
    expect(subject).toBe('Nous avons bien reçu votre message');
    expect(body).toContain('nous répondrons à asha@gmail.com');
    expect(body).toContain('Votre référence est cmg123.');
  });
});
