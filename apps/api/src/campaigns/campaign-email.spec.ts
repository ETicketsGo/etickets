import { renderCampaignEmail, type CampaignRenderInput } from './campaign-email';
import { contentSchema } from './campaign-content';
import {
  allowedCampaignTarget,
  clickKey,
  signClickToken,
  verifyClickToken,
} from './campaign-links';
import {
  campaignFromHeader,
  campaignSendingConfig,
  isSimulatorAddress,
} from './campaign-sending-config';
import { classifySendError } from './campaign-transport';
import { csvCell } from './campaign-analytics.service';
import { signConfirmation, verifyConfirmation } from './campaign-guard';

const CONFIG: Record<string, string> = {
  JWT_ACCESS_SECRET: 'unit-test-secret-unit-test-secret-unit-test',
  CUSTOMER_WEB_URL: 'https://qa.eticketsgo.com',
  PUBLIC_API_URL: 'https://api-qa.eticketsgo.com',
  APP_ENV: 'QA',
};
const config = { get: (k: string) => CONFIG[k] } as never;

const EVIL = `<script>alert(1)</script><img src=x onerror=alert(2)>"'`;

function input(over: Partial<CampaignRenderInput> = {}): CampaignRenderInput {
  return {
    locale: 'en',
    subject: 'Hello',
    previewText: 'Preview',
    purpose: 'ORGANIZER_UPDATES',
    blocks: [{ type: 'paragraph', text: 'Hi' }],
    organizer: { name: 'Acme Shows', logoUrl: null },
    mainEventImageUrl: null,
    events: {},
    link: (t) =>
      `https://api-qa.eticketsgo.com/api/public/campaign-links/tok?t=${encodeURIComponent(t)}`,
    unsubscribeUrl: 'https://qa.eticketsgo.com/unsubscribe/abc',
    platform: { legalName: 'DeepTrics LLC', postalAddress: '1 Main St, Springfield' },
    ...over,
  };
}

describe('campaign email rendering', () => {
  it('escapes every organizer-supplied text: subject, heading, paragraph, offer, name', () => {
    const { html, text } = renderCampaignEmail(
      input({
        subject: EVIL,
        previewText: EVIL,
        organizer: { name: EVIL, logoUrl: null },
        blocks: [
          { type: 'heading', text: EVIL },
          { type: 'paragraph', text: EVIL },
          { type: 'offer', text: EVIL, code: 'SAVE10' },
          { type: 'button', label: EVIL, url: 'https://qa.eticketsgo.com/events/x' },
        ],
      }),
    );
    expect(html).not.toContain('<script>');
    expect(html).not.toMatch(/<img src=x/);
    expect(html).not.toMatch(/<img[^>]*onerror/i);
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
    // No markup the renderer did not write: every tag is one of ours.
    const tags = new Set([...html.matchAll(/<([a-z0-9]+)[\s>/]/gi)].map((m) => m[1].toLowerCase()));
    for (const tag of tags) {
      expect([
        'html',
        'head',
        'meta',
        'title',
        'style',
        'body',
        'div',
        'table',
        'tr',
        'td',
        'p',
        'a',
        'h2',
        'hr',
        'img',
        'span',
      ]).toContain(tag);
    }
    expect(html).not.toMatch(/javascript:/i);
    // The text part is plain text; it carries the words, not markup.
    expect(text).toContain('<script>alert(1)</script>');
  });

  it('drops a link the tracker refuses, and keeps the words', () => {
    const { html } = renderCampaignEmail(
      input({
        link: () => null,
        blocks: [{ type: 'button', label: 'Go', url: 'https://evil.example/phish' }],
      }),
    );
    expect(html).not.toContain('evil.example');
  });

  it('always carries the footer: why, unsubscribe, sender identity and the operator', () => {
    const { html, text } = renderCampaignEmail(input());
    expect(html).toContain(
      'You are getting this email because you agreed to hear from Acme Shows about their events.',
    );
    expect(html).toContain('href="https://qa.eticketsgo.com/unsubscribe/abc"');
    expect(html).toContain('Unsubscribe from Acme Shows');
    expect(html).toContain('Sent by Acme Shows with ETicketsGo.');
    expect(html).toContain('ETicketsGo is operated by DeepTrics LLC.');
    expect(html).toContain('1 Main St, Springfield');
    expect(text).toContain(
      'Unsubscribe from Acme Shows: https://qa.eticketsgo.com/unsubscribe/abc',
    );
  });

  it('refuses to render without a working unsubscribe link', () => {
    expect(() => renderCampaignEmail(input({ unsubscribeUrl: 'javascript:alert(1)' }))).toThrow(
      /unsubscribe/,
    );
  });

  it('writes the footer in French for fr-CA', () => {
    const { html } = renderCampaignEmail(input({ locale: 'fr-CA' }));
    expect(html).toContain('lang="fr-CA"');
    expect(html).toContain('Se désabonner de Acme Shows');
  });

  it('an image is only ever the event poster or the logo, and a non-http one is dropped', () => {
    const { html } = renderCampaignEmail(
      input({
        mainEventImageUrl: 'javascript:alert(1)',
        blocks: [{ type: 'image', source: 'EVENT', alt: 'x' }],
      }),
    );
    expect(html).not.toContain('javascript:');
  });
});

describe('campaign content validation', () => {
  it('refuses raw HTML blocks and arbitrary image URLs by shape', () => {
    expect(contentSchema.safeParse({ blocks: [{ type: 'html', html: '<b>x</b>' }] }).success).toBe(
      false,
    );
    expect(
      contentSchema.safeParse({
        blocks: [{ type: 'image', url: 'https://tracker.example/p.gif', alt: 'x' }],
      }).success,
    ).toBe(false);
  });
  it('refuses hidden control characters (bidi overrides) in text', () => {
    expect(
      contentSchema.safeParse({ blocks: [{ type: 'paragraph', text: 'abc‮def' }] }).success,
    ).toBe(false);
  });
  it('a promo code is letters, numbers and dashes only', () => {
    expect(
      contentSchema.safeParse({ blocks: [{ type: 'offer', text: 'x', code: '"><script>' }] })
        .success,
    ).toBe(false);
  });
});

describe('link allowlist', () => {
  it.each([
    ['https://qa.eticketsgo.com/events/x', true],
    ['https://eticketsgo.com/', true],
    ['https://www.eticketsgo.com/organizers/1', true],
    ['https://api-qa.eticketsgo.com/api/public/events/1/image', true],
    ['http://eticketsgo.com/', false],
    ['https://eticketsgo.com.evil.example/', false],
    ['https://evil.example/?u=https://eticketsgo.com', false],
    ['https://eticketsgo.com@evil.example/', false],
    ['javascript:alert(1)', false],
    ['data:text/html,<script>', false],
    ['not a url', false],
  ])('%s -> %s', (url, ok) => {
    expect(!!allowedCampaignTarget(config, url)).toBe(ok);
  });
});

describe('click tokens', () => {
  const key = clickKey(config);
  it('round-trips and refuses tampering', () => {
    const token = signClickToken({ linkId: 'link1', recipientId: 'rec1' }, key);
    expect(verifyClickToken(token, key)).toEqual({ linkId: 'link1', recipientId: 'rec1' });
    const [body, sig] = token.split('.');
    const forged = Buffer.from('link1.rec2').toString('base64url');
    expect(verifyClickToken(`${forged}.${sig}`, key)).toBeNull();
    expect(verifyClickToken(`${body}.AAAA`, key)).toBeNull();
    expect(
      verifyClickToken(token, clickKey({ get: () => 'another-secret-another-secret-x' } as never)),
    ).toBeNull();
  });
});

describe('confirmation token', () => {
  it('binds to the campaign, the version and the clock', () => {
    const t = signConfirmation(config, 'c1', 3, 1_000_000);
    expect(verifyConfirmation(config, 'c1', 3, t, 1_000_000)).toBe(true);
    expect(verifyConfirmation(config, 'c1', 4, t, 1_000_000)).toBe(false);
    expect(verifyConfirmation(config, 'c2', 3, t, 1_000_000)).toBe(false);
    expect(verifyConfirmation(config, 'c1', 3, t, 1_000_000 + 16 * 60_000)).toBe(false);
    expect(verifyConfirmation(config, 'c1', 3, undefined)).toBe(false);
  });
});

describe('sending config', () => {
  const cfg = (env: Record<string, string>) =>
    campaignSendingConfig({ get: (k: string) => env[k] } as never);
  it('is off by default', () => {
    expect(cfg({}).refusal).toMatch(/not switched on/);
  });
  it('QA falls back to the transactional sender and says so', () => {
    const c = cfg({
      CAMPAIGNS_ENABLED: 'true',
      EMAIL_PROVIDER: 'ses',
      EMAIL_FROM: 't@x.com',
      SES_CONFIGURATION_SET: 'qa-tx',
      APP_ENV: 'QA',
    });
    expect(c.refusal).toBeNull();
    expect(c.mode).toBe('SHARED_TRANSACTIONAL');
    expect(c.configurationSet).toBe('qa-tx');
    expect(c.simulatorAllowed).toBe(true);
  });
  it('PRODUCTION refuses without a dedicated marketing sender and postal address', () => {
    const base = {
      CAMPAIGNS_ENABLED: 'true',
      EMAIL_PROVIDER: 'ses',
      EMAIL_FROM: 't@x.com',
      APP_ENV: 'PRODUCTION',
    };
    expect(cfg(base).refusal).toMatch(/MARKETING_EMAIL_FROM/);
    expect(
      cfg({ ...base, MARKETING_EMAIL_FROM: 'm@x.com', SES_MARKETING_CONFIGURATION_SET: 'mk' })
        .refusal,
    ).toMatch(/POSTAL/);
    const ok = cfg({
      ...base,
      MARKETING_EMAIL_FROM: 'm@x.com',
      SES_MARKETING_CONFIGURATION_SET: 'mk',
      MARKETING_POSTAL_ADDRESS: 'x',
    });
    expect(ok.refusal).toBeNull();
    expect(ok.mode).toBe('DEDICATED_MARKETING');
    expect(ok.simulatorAllowed).toBe(false);
    expect(cfg({ ...base, EMAIL_PROVIDER: 'log' }).refusal).toMatch(/log/);
  });
  it('the rate is clamped', () => {
    expect(cfg({ CAMPAIGN_SEND_RATE_PER_SECOND: '500' }).ratePerSecond).toBe(50);
    expect(cfg({}).ratePerSecond).toBe(5);
  });
  it('the From name cannot inject an address or a header', () => {
    expect(campaignFromHeader('Acme "<evil@x.com>"\r\nBcc: a@b', 'c@eticketsgo.com')).toBe(
      '"Acme evil@x.com Bcc: a@b via ETicketsGo" <c@eticketsgo.com>',
    );
  });
  it('recognises the SES simulator', () => {
    expect(isSimulatorAddress('success@simulator.amazonses.com')).toBe(true);
    expect(isSimulatorAddress('success@simulator.amazonses.com.evil')).toBe(false);
  });
});

describe('send error classes', () => {
  it.each([
    [{ name: 'MessageRejected' }, 'REJECTED'],
    [{ name: 'SendingPausedException' }, 'ACCOUNT'],
    [{ name: 'TooManyRequestsException', $metadata: { httpStatusCode: 429 } }, 'TRANSIENT'],
    [{ name: 'TimeoutError' }, 'TRANSIENT'],
    [{ name: 'X', $metadata: { httpStatusCode: 400 } }, 'REJECTED'],
  ])('%j -> %s', (err, kind) => {
    expect(classifySendError(err)).toBe(kind);
  });
});

describe('CSV cells', () => {
  it('quotes and neutralises formulas', () => {
    expect(csvCell('=HYPERLINK("x")')).toBe(`"'=HYPERLINK(""x"")"`);
    expect(csvCell('Diwali, 2026')).toBe('"Diwali, 2026"');
  });
});
