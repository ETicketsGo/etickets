import { ConfigService } from '@nestjs/config';
import { NotificationType } from '@eticketsgo/shared-types';
import {
  marketsForE164,
  parseMarketProviderMap,
  routeNotificationProvider,
} from '@eticketsgo/shared-types';
import { NotificationProviderResolver } from '../channels/notification-provider.resolver';
import type { RenderedNotification } from '../channels/notification-channel.interface';

/**
 * Which provider carries a message, and what happens when nobody can.
 *
 * ── WHAT THIS IS PROVING ───────────────────────────────────────────────────────────
 * Before this, each channel held ONE transport, chosen once at boot from one environment
 * variable, so a message to Mumbai and a message to Toronto necessarily went the same way.
 * The launch requirement is that they do not: India needs MSG91 because an Indian operator
 * will not carry a message sent under an unregistered sender, and North America needs Twilio.
 *
 * The second half of these — the refusals — matter more than the routes. A message that
 * cannot be attributed to a market must not fall through to whichever provider happened to
 * be the default, because that failure is invisible: the API accepts it, the carrier drops
 * it, and the first anybody hears is a customer saying their ticket never arrived.
 */

const LAUNCH_SMS = 'IN=msg91,US=twilio,CA=twilio';
const LAUNCH_WHATSAPP = 'IN=msg91,US=cloud,CA=cloud';

function config(over: Record<string, string> = {}) {
  const values: Record<string, string> = {
    SMS_PROVIDER_BY_MARKET: LAUNCH_SMS,
    WHATSAPP_PROVIDER_BY_MARKET: LAUNCH_WHATSAPP,
    // Credentials for every provider the launch matrix can pick, so construction succeeds.
    TWILIO_ACCOUNT_SID: 'ACtest',
    TWILIO_AUTH_TOKEN: 'secret-token',
    TWILIO_FROM_NUMBER: '+15550000000',
    MSG91_AUTH_KEY: 'msg91-secret',
    MSG91_WHATSAPP_NUMBER: '919999999999',
    WHATSAPP_PHONE_NUMBER_ID: '123456',
    WHATSAPP_ACCESS_TOKEN: 'meta-secret',
    ...over,
  };
  return new ConfigService(values);
}

function msg(over: Partial<RenderedNotification> = {}): RenderedNotification {
  return {
    type: NotificationType.BOOKING_CANCELLED,
    channel: 'sms',
    locale: 'en',
    subject: 'S',
    body: 'B',
    payload: {},
    userId: 'u1',
    ...over,
  };
}

jest.mock('twilio', () => ({
  __esModule: true,
  default: () => ({ messages: { create: jest.fn() } }),
}));

describe('the market a destination belongs to', () => {
  it.each([
    ['+919876543210', ['IN']],
    ['+14155550123', ['US', 'CA']],
    ['+16475550123', ['US', 'CA']],
    ['+442071234567', ['GB']],
    ['+971501234567', ['AE']],
  ])('%s → %s', (phone, expected) => {
    expect(marketsForE164(phone)).toEqual(expected);
  });

  it('reads +971 as the Emirates and not as +9 followed by something', () => {
    // Longest calling code first. Getting this backwards would route Dubai to India.
    expect(marketsForE164('+971501234567')).toEqual(['AE']);
  });

  it('has no market for a number that is not E.164', () => {
    expect(marketsForE164('9876543210')).toEqual([]);
    expect(marketsForE164('')).toEqual([]);
    expect(marketsForE164(null)).toEqual([]);
  });
});

describe('the routing table itself', () => {
  it('parses the launch matrix', () => {
    expect(parseMarketProviderMap(LAUNCH_SMS)).toEqual({
      IN: 'msg91',
      US: 'twilio',
      CA: 'twilio',
    });
  });

  it('ignores entries that are not a market and a provider', () => {
    expect(parseMarketProviderMap('IN=msg91,,=twilio,ZZZZ=x,US=')).toEqual({ IN: 'msg91' });
  });

  it('falls back to the single-provider setting when no table is configured', () => {
    // What every local and single-market deployment does, and the reason the old
    // SMS_PROVIDER key keeps its meaning.
    expect(routeNotificationProvider({ marketProviders: {}, defaultProvider: 'log' })).toEqual({
      ok: true,
      provider: 'log',
      market: null,
    });
  });
});

describe('the launch routing matrix', () => {
  const resolver = () => new NotificationProviderResolver(config());

  it.each([
    ['+919876543210', 'msg91'],
    ['+14155550123', 'twilio'],
    ['+16475550123', 'twilio'],
  ])('SMS to %s goes to %s', (destination, provider) => {
    const routed = resolver().routeSms(msg({ destination }));
    expect(routed).toMatchObject({ ok: true, provider });
  });

  it.each([
    ['+919876543210', 'msg91'],
    ['+14155550123', 'cloud'],
  ])('WhatsApp to %s goes to %s', (destination, provider) => {
    const routed = resolver().routeWhatsApp(msg({ channel: 'whatsapp', destination }));
    expect(routed).toMatchObject({ ok: true, provider });
  });

  it('a market the caller states beats the number', () => {
    // Trusted business context wins when the sender genuinely has it.
    const routed = resolver().routeSms(msg({ destination: '+14155550123', country: 'India' }));
    expect(routed).toMatchObject({ ok: true, provider: 'msg91', market: 'IN' });
  });

  it('accepts a country written any of the ways this platform stores them', () => {
    for (const country of ['IN', 'ind', 'India', 'INDIA']) {
      expect(resolver().routeSms(msg({ country }))).toMatchObject({ provider: 'msg91' });
    }
  });

  it('builds each provider once and reuses it', () => {
    // Lazy construction plus a cache, exactly as the payment registry does — so boot never
    // needs every vendor's credentials, and a route does not rebuild a client per message.
    const r = resolver();
    const first = r.routeSms(msg({ destination: '+919876543210' }));
    const second = r.routeSms(msg({ destination: '+919000000000' }));
    expect(first).toMatchObject({ ok: true });
    expect(second).toMatchObject({ ok: true });
    if (first.ok && second.ok) expect(first.transport).toBe(second.transport);
  });
});

describe('what happens when no route can be chosen', () => {
  const resolver = () => new NotificationProviderResolver(config());

  it('refuses a destination whose market cannot be determined', () => {
    /*
      The alternative would be to send it through the default provider. That is the failure
      this refusal exists to prevent: an unattributable number sent through a North American
      route is either undeliverable or billed at an international rate, and nothing about it
      looks wrong until somebody complains.
    */
    expect(resolver().routeSms(msg({ destination: '9876543210' }))).toMatchObject({
      ok: false,
      refusal: 'unknown_market',
    });
  });

  it('refuses a market that is real but has no provider configured', () => {
    expect(resolver().routeSms(msg({ destination: '+442071234567' }))).toMatchObject({
      ok: false,
      refusal: 'unsupported_market',
      market: 'GB',
    });
  });

  it('refuses +1 when the United States and Canada are routed differently', () => {
    // A +1 number cannot say which of the two it is. While both go to Twilio that does not
    // matter; the moment they disagree, guessing would be picking a vendor at random.
    const split = new NotificationProviderResolver(
      config({ SMS_PROVIDER_BY_MARKET: 'US=twilio,CA=msg91' }),
    );
    expect(split.routeSms(msg({ destination: '+14155550123' }))).toMatchObject({
      ok: false,
      refusal: 'ambiguous_market',
    });
  });

  it('still routes +1 while the two agree', () => {
    expect(resolver().routeSms(msg({ destination: '+14155550123' }))).toMatchObject({
      ok: true,
      provider: 'twilio',
    });
  });

  it('routes everything to the default when no table is configured at all', () => {
    const single = new NotificationProviderResolver(new ConfigService({ SMS_PROVIDER: 'log' }));
    expect(single.routeSms(msg({ destination: '+442071234567' }))).toMatchObject({
      ok: true,
      provider: 'log',
    });
  });
});
