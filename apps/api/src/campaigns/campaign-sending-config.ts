import type { ConfigService } from '@nestjs/config';
import { legalEntityFor } from '@eticketsgo/shared-types';

/**
 * Whether this deployment may send campaign email, and with which sender.
 *
 * ── THE RULE ───────────────────────────────────────────────────────────────────────
 *   - CAMPAIGNS_ENABLED must be "true" everywhere. Default false.
 *   - Campaigns go through SES only (EMAIL_PROVIDER=ses), or the log transport where nothing
 *     is ever delivered (LOCAL, DEV, QA, UAT). SES is the only provider whose delivery,
 *     bounce and complaint events this platform maps back to a campaign.
 *   - STAGING and PRODUCTION need a marketing sender of their own: MARKETING_EMAIL_FROM
 *     (`updates@eticketsgo.com`, once SES has verified it) and SES_MARKETING_CONFIGURATION_SET.
 *     A campaign that fell back to the ticket sender would put marketing complaints on the
 *     reputation that delivers tickets.
 *   - STAGING and PRODUCTION need UNSUBSCRIBE_SIGNING_SECRET. Elsewhere the unsubscribe key may
 *     be derived from JWT_ACCESS_SECRET; in a live environment that would tie every unsubscribe
 *     link ever sent to the access-token secret, and rotating it would break them all.
 *   - The footer's postal address is per COUNTRY (`campaignFooterAddress`), checked for each
 *     campaign at review, at send and before every message.
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
    if (!config.get<string>('UNSUBSCRIBE_SIGNING_SECRET')?.trim()) {
      return refuse(
        'Campaigns need UNSUBSCRIBE_SIGNING_SECRET in this environment. Unsubscribe links are not signed with the sign-in secret here.',
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

/** The default marketing sender, once SES has verified it. Documented, never assumed. */
export const DEFAULT_MARKETING_EMAIL_FROM = 'updates@eticketsgo.com';

/** What QA and local footers print while no verified address exists. Never a real address. */
export const POSTAL_ADDRESS_PLACEHOLDER = 'Postal address pending verification (QA)';

export interface CampaignFooterAddress {
  /** The address to print, or the QA placeholder. Null only with a refusal. */
  address: string | null;
  /** Which DeepTrics entity the footer names, and so whose address it is: IN or US. */
  entityCountry: string;
  /** Which variable it came from. */
  source: 'COUNTRY' | 'LEGACY' | 'PLACEHOLDER' | null;
  /** Null when a campaign may be sent. Otherwise a sentence for a person. */
  refusal: string | null;
}

/**
 * The verified DeepTrics business mailing address a campaign footer prints, for the SENDING
 * ORGANIZER's country. Anti-spam law (CAN-SPAM in the US; the IT Rules and DPDP expectations
 * in India) asks for a valid physical postal address of the sender in every marketing email.
 *
 * ── THE RULE ───────────────────────────────────────────────────────────────────────
 *   1. The organizer's registered country picks the entity the footer names
 *      (`legalEntityFor`): India -> the Indian company, anything else -> DeepTrics LLC (US).
 *   2. The address is MARKETING_POSTAL_ADDRESS_<IN|US> for that entity.
 *   3. Fallback ONLY: the old single MARKETING_POSTAL_ADDRESS, when it is set. Never the other
 *      country's address: a US address under the Indian company's name would be wrong.
 *   4. STAGING and PRODUCTION refuse the campaign when neither is set.
 *   5. LOCAL, DEV, QA and UAT print a clearly labelled placeholder instead, so a test send
 *      shows where the address goes without anybody inventing one.
 */
export function campaignFooterAddress(
  config: Pick<ConfigService, 'get'>,
  organizerCountry: string | null | undefined,
): CampaignFooterAddress {
  const appEnv = String(config.get<string>('APP_ENV') ?? 'LOCAL').toUpperCase();
  const entityCountry = legalEntityFor(organizerCountry).country;
  const variable = `MARKETING_POSTAL_ADDRESS_${entityCountry}`;
  const perCountry = config.get<string>(variable)?.trim() || null;
  if (perCountry) {
    return { address: perCountry, entityCountry, source: 'COUNTRY', refusal: null };
  }
  const legacy = config.get<string>('MARKETING_POSTAL_ADDRESS')?.trim() || null;
  if (legacy) return { address: legacy, entityCountry, source: 'LEGACY', refusal: null };
  if (LIVE.includes(appEnv)) {
    return {
      address: null,
      entityCountry,
      source: null,
      refusal: `Campaigns need ${variable} (the verified business mailing address for the email footer) in this environment.`,
    };
  }
  return {
    address: POSTAL_ADDRESS_PLACEHOLDER,
    entityCountry,
    source: 'PLACEHOLDER',
    refusal: null,
  };
}
