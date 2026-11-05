import { NotificationType } from '@eticketsgo/shared-types';
import { buildEmailView } from './email-view';
import { renderEmailHtml } from './email-html';
import { renderCampaignEmail } from '../../campaigns/campaign-email';

/**
 * The email footer names the DeepTrics company the message is about.
 *
 * From the payload only: a booking's currency (INR the Indian company, USD DeepTrics LLC),
 * else a country a producer set. A message about neither names both companies.
 */
const INDIA = 'ETicketsGo is operated in India by DeepTrics Software Solutions Private Limited.';
const US = 'ETicketsGo is operated in the United States by DeepTrics LLC.';
const NEUTRAL =
  'ETicketsGo is operated in India by DeepTrics Software Solutions Private Limited and in the United States by DeepTrics LLC.';

function view(
  payload: Record<string, unknown>,
  type: NotificationType = NotificationType.BOOKING_CONFIRMED,
) {
  return buildEmailView({
    type,
    locale: 'en',
    subject: 'Your booking is confirmed',
    body: 'Booking confirmed.',
    payload: { reference: 'ETG-IND-2026-000001', eventTitle: 'Show', ...payload },
  });
}

describe('transactional email footer', () => {
  it('an INR booking names the Indian company', () => {
    const v = view({ currency: 'INR' });
    expect(v.operator).toBe(INDIA);
    expect(renderEmailHtml(v)).toContain(INDIA);
  });

  it('a USD booking names DeepTrics LLC', () => {
    const v = view({ currency: 'USD' });
    expect(v.operator).toBe(US);
    const html = renderEmailHtml(v);
    expect(html).toContain(US);
    expect(html).not.toContain('Private Limited');
  });

  it('a message with no currency or country names both companies', () => {
    const v = view({}, NotificationType.PASSWORD_RESET_REQUESTED);
    expect(v.operator).toBe(NEUTRAL);
    expect(renderEmailHtml(v)).toContain(NEUTRAL);
  });

  it('a view built without an operator renders as it did before', () => {
    const { operator: _omit, ...rest } = view({ currency: 'INR' });
    void _omit;
    expect(renderEmailHtml(rest)).not.toMatch(/operated in/);
  });
});

describe('marketing (campaign) email footer', () => {
  const base = {
    locale: 'en',
    subject: 'News',
    previewText: null,
    blocks: [],
    purpose: 'ORGANIZER_UPDATES',
    organizer: { name: 'Hall', logoUrl: null },
    mainEventImageUrl: null,
    events: {},
    link: (t: string) => t,
    unsubscribeUrl: 'https://www.eticketsgo.com/u/1',
    unsubscribeAllUrl: 'https://www.eticketsgo.com/u/all',
  };

  it('names the company for the organizer country with the owner sentence', () => {
    const india = renderCampaignEmail({
      ...base,
      platform: {
        legalName: 'DeepTrics Software Solutions Private Limited',
        country: 'IN',
        postalAddress: null,
      },
    } as never);
    expect(india.html).toContain(INDIA);
    const us = renderCampaignEmail({
      ...base,
      platform: { legalName: 'DeepTrics LLC', country: 'US', postalAddress: null },
    } as never);
    expect(us.html).toContain(US);
  });
});
