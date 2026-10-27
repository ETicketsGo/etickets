import type { ConfigService } from '@nestjs/config';

/**
 * Whether this deployment may send campaign email, and with which sender.
 *
 * ── THE RULE ───────────────────────────────────────────────────────────────────────
 *   - CAMPAIGNS_ENABLED must be "true" everywhere. Default false.
 *   - Campaigns go through SES only (EMAIL_PROVIDER=ses), or the log transport where nothing
 *     is ever delivered (LOCAL, DEV, QA, UAT). SES is the only provider whose delivery,
 *     bounce and complaint events this platform maps back to a campaign.
 *   - STAGING and PRODUCTION need a marketing sender of their own: MARKETING_EMAIL_FROM and
 *     SES_MARKETING_CONFIGURATION_SET, and the postal address the footer must print. A
 *     campaign that fell back to the ticket sender would put marketing complaints on the
 *     reputation that delivers tickets.
 *   - Everywhere else an unset pair falls back to EMAIL_FROM and SES_CONFIGURATION_SET, and
 *     `mode` says SHARED_TRANSACTIONAL so the console can say so plainly.
 *
 * Pure apart from reading config, so the decision is unit-tested with no SES at all.
 */

export type CampaignSendingMode = 'DEDICATED_MARKETING' | 'SHARED_TRANSACTIONAL' | 'LOG_ONLY';

export interface CampaignSendingConfig {
  enabled: boolean;
  /** Null when sending is allowed. Otherwise a sentence for a person. */
  refusal: string | null;
  mode: CampaignSendingMode | null;
  provider: 'ses' | 'log' | null;
  fromAddress: string | null;
  configurationSet: string | null;
  postalAddress: string | null;
  ratePerSecond: number;
  appEnv: string;
  /** Whether SES mailbox-simulator addresses may receive a test send here. */
  simulatorAllowed: boolean;
}

const LIVE = ['STAGING', 'PRODUCTION'];

export function campaignSendingConfig(config: Pick<ConfigService, 'get'>): CampaignSendingConfig {
  const appEnv = String(config.get<string>('APP_ENV') ?? 'LOCAL').toUpperCase();
  const enabled = String(config.get<string>('CAMPAIGNS_ENABLED') ?? 'false') === 'true';
  const provider = String(config.get<string>('EMAIL_PROVIDER') ?? 'log');
  const rawRate = Number(config.get<number>('CAMPAIGN_SEND_RATE_PER_SECOND') ?? 5);
  const ratePerSecond =
    Number.isFinite(rawRate) && rawRate >= 1 ? Math.min(50, Math.floor(rawRate)) : 5;
  const marketingFrom = config.get<string>('MARKETING_EMAIL_FROM')?.trim() || null;
  const marketingSet = config.get<string>('SES_MARKETING_CONFIGURATION_SET')?.trim() || null;
  const postalAddress = config.get<string>('MARKETING_POSTAL_ADDRESS')?.trim() || null;
  const live = LIVE.includes(appEnv);
  const base = {
    enabled,
    ratePerSecond,
    appEnv,
    postalAddress,
    simulatorAllowed: !live,
  };
  const refuse = (refusal: string): CampaignSendingConfig => ({
    ...base,
    refusal,
    mode: null,
    provider: null,
    fromAddress: null,
    configurationSet: null,
  });

  if (!enabled) return refuse('Email campaigns are not switched on in this environment.');

  if (provider === 'log') {
    if (live) return refuse('Campaigns cannot use the log email provider here.');
    return {
      ...base,
      refusal: null,
      mode: 'LOG_ONLY',
      provider: 'log',
      fromAddress:
        marketingFrom ?? config.get<string>('EMAIL_FROM')?.trim() ?? 'campaigns@localhost',
      configurationSet: null,
    };
  }
  if (provider !== 'ses') {
    return refuse('Campaigns send through Amazon SES only. Set EMAIL_PROVIDER=ses.');
  }
  if (live) {
    if (!marketingFrom || !marketingSet) {
      return refuse(
        'Campaigns need MARKETING_EMAIL_FROM and SES_MARKETING_CONFIGURATION_SET in this environment.',
      );
    }
    if (!postalAddress) {
      return refuse(
        'Campaigns need MARKETING_POSTAL_ADDRESS for the email footer in this environment.',
      );
    }
    return {
      ...base,
      refusal: null,
      mode: 'DEDICATED_MARKETING',
      provider: 'ses',
      fromAddress: marketingFrom,
      configurationSet: marketingSet,
    };
  }
  const from = marketingFrom ?? config.get<string>('EMAIL_FROM')?.trim() ?? null;
  if (!from) return refuse('Campaigns need MARKETING_EMAIL_FROM or EMAIL_FROM.');
  const set = marketingSet ?? config.get<string>('SES_CONFIGURATION_SET')?.trim() ?? null;
  return {
    ...base,
    refusal: null,
    mode: marketingFrom && marketingSet ? 'DEDICATED_MARKETING' : 'SHARED_TRANSACTIONAL',
    provider: 'ses',
    fromAddress: from,
    configurationSet: set,
  };
}

/**
 * The From header: `"<Organizer> via ETicketsGo" <address>`.
 *
 * The organizer's name is shown, the address is ours (only our domain is verified with SES,
 * and DMARC would fail on anything else). Quotes, angle brackets, backslashes and line breaks
 * are removed from the name: any of them would let a name start a second address or a header.
 */
export function campaignFromHeader(senderName: string, address: string): string {
  const name = senderName
    .replace(/[\r\n"<>\\]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 60);
  return name ? `"${name} via ETicketsGo" <${address}>` : address;
}

/** SES mailbox simulator addresses: accepted, bounced, complained, and so on, never delivered. */
export function isSimulatorAddress(email: string): boolean {
  return /^[a-z0-9+._-]+@simulator\.amazonses\.com$/i.test(email.trim());
}
