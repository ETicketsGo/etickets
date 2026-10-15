/**
 * The controlled India pilot, as configuration.
 *
 * ── WHY THIS EXISTS ───────────────────────────────────────────────────────────────
 * The owner's condition for the first real-money India pilot (2026-10-15) is that its limits
 * live IN CODE, not in a runbook: one approved organizer, general admission only, Razorpay in
 * rupees only, at most Rs 2,000 an order and Rs 25,000 a day. Before this the only limit the
 * sale path knew was a ticket type's `maxPerOrder`.
 *
 * Everything here is pure: it reads a plain record of environment strings and answers. The
 * service around it does the database work. Kept apart so the rules can be tested without a
 * Nest module, and so the parse can never throw into a request.
 *
 * ── FAIL CLOSED ───────────────────────────────────────────────────────────────────
 * Pilot mode that cannot be understood sells NOTHING. A cap that does not parse is not "no
 * cap", and an empty organizer list is not "every organizer". The API still boots (a refusal
 * to boot would take admin and the storefront down with it), the readiness line on Admin >
 * Operations says what is wrong, and every sale answers SALE_NOT_OPEN with PILOT_MISCONFIGURED.
 *
 * Unset PILOT_MODE, or `off`, is the platform exactly as it was.
 */

export const PILOT_BLOCKERS = [
  'PILOT_MISCONFIGURED',
  'PILOT_ORGANIZER_NOT_ALLOWED',
  'PILOT_RESERVED_SEATING',
  'PILOT_CURRENCY',
  'PILOT_PROVIDER',
  'PILOT_ORDER_LIMIT',
  'PILOT_DAILY_LIMIT',
  'PILOT_BUYER_NOT_ALLOWED',
  'PILOT_EVENT_NOT_ON_SALE',
] as const;
export type PilotBlocker = (typeof PILOT_BLOCKERS)[number];

/** The environment variables, by name. Read nowhere else. */
export const PILOT_ENV = [
  'PILOT_MODE',
  'PILOT_ALLOWED_ORGANIZATION_IDS',
  'PILOT_ALLOWED_CURRENCIES',
  'PILOT_ALLOWED_PROVIDERS',
  'PILOT_GA_ONLY',
  'PILOT_MAX_ORDER_MINOR',
  'PILOT_MAX_DAILY_SALES_MINOR',
  'PILOT_ALLOWED_BUYER_EMAILS',
  'PILOT_AUTO_PAUSE',
  'PILOT_WEBHOOK_REJECT_PAUSE_THRESHOLD',
] as const;
export type PilotEnvName = (typeof PILOT_ENV)[number];
export type PilotEnv = Partial<Record<PilotEnvName, string | undefined>>;

/** Rejections counted inside this window for the webhook trigger. Fixed by the owner's brief. */
export const PILOT_WEBHOOK_WINDOW_MS = 10 * 60 * 1000;
export const DEFAULT_WEBHOOK_REJECT_THRESHOLD = 3;

export interface PilotLimits {
  organizationIds: string[];
  currencies: string[];
  providers: string[];
  gaOnly: boolean;
  maxOrderMinor: number;
  maxDailySalesMinor: number;
  /** Lower-cased. Empty = any buyer. */
  buyerEmails: string[];
  autoPause: boolean;
  webhookRejectThreshold: number;
}

export type PilotConfig =
  | { mode: 'off' }
  | { mode: 'on'; valid: true; limits: PilotLimits }
  | {
      mode: 'on';
      valid: false;
      /** Plain sentences naming the variable. Never a value: an e-mail list is personal data. */
      problems: string[];
      /** What could be read, so auto-pause still works while sales are closed. */
      autoPause: boolean;
      webhookRejectThreshold: number;
      organizationIds: string[];
    };

const list = (raw: string | undefined): string[] =>
  (raw ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

/** A whole, non-negative number of minor units, written as digits only. Null otherwise. */
function minor(raw: string | undefined): number | null {
  const s = (raw ?? '').trim();
  if (!/^\d+$/.test(s)) return null;
  const n = Number(s);
  return Number.isSafeInteger(n) ? n : null;
}

/** on|off, with a default. Anything else is a typo, and a typo is not a decision. */
function onOff(raw: string | undefined, fallback: boolean): boolean | null {
  const s = (raw ?? '').trim().toLowerCase();
  if (!s) return fallback;
  if (s === 'on' || s === 'true') return true;
  if (s === 'off' || s === 'false') return false;
  return null;
}

export function parsePilotConfig(env: PilotEnv): PilotConfig {
  const mode = (env.PILOT_MODE ?? '').trim().toLowerCase();
  if (mode === '' || mode === 'off') return { mode: 'off' };

  const problems: string[] = [];
  // Anything that is not plainly "off" is treated as on: a typo must not open sales.
  if (mode !== 'on') problems.push('PILOT_MODE must be on or off.');

  const organizationIds = list(env.PILOT_ALLOWED_ORGANIZATION_IDS);
  if (organizationIds.length === 0) {
    problems.push('PILOT_ALLOWED_ORGANIZATION_IDS is empty, so no organizer may sell.');
  }
  const currencies = (
    env.PILOT_ALLOWED_CURRENCIES === undefined ? ['INR'] : list(env.PILOT_ALLOWED_CURRENCIES)
  ).map((c) => c.toUpperCase());
  if (currencies.length === 0) problems.push('PILOT_ALLOWED_CURRENCIES is empty.');
  const providers = (
    env.PILOT_ALLOWED_PROVIDERS === undefined ? ['razorpay'] : list(env.PILOT_ALLOWED_PROVIDERS)
  ).map((p) => p.toLowerCase());
  if (providers.length === 0) problems.push('PILOT_ALLOWED_PROVIDERS is empty.');

  const gaOnly = onOff(env.PILOT_GA_ONLY, true);
  if (gaOnly === null) problems.push('PILOT_GA_ONLY must be true or false.');

  const maxOrderMinor = minor(env.PILOT_MAX_ORDER_MINOR);
  if (maxOrderMinor === null || maxOrderMinor === 0) {
    problems.push('PILOT_MAX_ORDER_MINOR must be a whole number of paise above zero.');
  }
  const maxDailySalesMinor = minor(env.PILOT_MAX_DAILY_SALES_MINOR);
  if (maxDailySalesMinor === null || maxDailySalesMinor === 0) {
    problems.push('PILOT_MAX_DAILY_SALES_MINOR must be a whole number of paise above zero.');
  }

  const buyerEmails = list(env.PILOT_ALLOWED_BUYER_EMAILS).map((e) => e.toLowerCase());
  if (buyerEmails.some((e) => !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e))) {
    // A half-typed address would refuse the owner's own verification payment; say so.
    problems.push('PILOT_ALLOWED_BUYER_EMAILS has an entry that is not an e-mail address.');
  }

  const autoPauseRead = onOff(env.PILOT_AUTO_PAUSE, true);
  if (autoPauseRead === null) problems.push('PILOT_AUTO_PAUSE must be on or off.');
  // Unreadable means ON: pausing too eagerly costs a sale, not pausing costs money.
  const autoPause = autoPauseRead ?? true;

  const thresholdRaw = env.PILOT_WEBHOOK_REJECT_PAUSE_THRESHOLD;
  const thresholdRead =
    thresholdRaw === undefined || thresholdRaw.trim() === ''
      ? DEFAULT_WEBHOOK_REJECT_THRESHOLD
      : minor(thresholdRaw);
  if (thresholdRead === null || thresholdRead === 0) {
    problems.push('PILOT_WEBHOOK_REJECT_PAUSE_THRESHOLD must be a whole number of 1 or more.');
  }
  const webhookRejectThreshold =
    thresholdRead && thresholdRead > 0 ? thresholdRead : DEFAULT_WEBHOOK_REJECT_THRESHOLD;

  if (problems.length > 0) {
    return {
      mode: 'on',
      valid: false,
      problems,
      autoPause,
      webhookRejectThreshold,
      organizationIds,
    };
  }
  return {
    mode: 'on',
    valid: true,
    limits: {
      organizationIds,
      currencies,
      providers,
      gaOnly: gaOnly as boolean,
      maxOrderMinor: maxOrderMinor as number,
      maxDailySalesMinor: maxDailySalesMinor as number,
      buyerEmails,
      autoPause,
      webhookRejectThreshold,
    },
  };
}

/** What a sale looks like to the pilot rules. Every field comes from our own rows. */
export interface PilotSale {
  organizationId: string;
  /** The session is in a room with a seat layout (screenId or seatMapId). */
  reservedSeating: boolean;
  /** A cinema show: the room belongs to a cinema, or the event is a movie. */
  cinema: boolean;
  currency: string;
  /** The gateway that would take the money. Null when nothing is charged (a free order). */
  provider: string | null;
  /** CASH means paying at the venue, which no pilot allows. */
  paymentMethod: 'ONLINE' | 'CASH';
  totalMinor: number;
  /**
   * Every address that identifies the buyer: the one typed at checkout and, when signed in,
   * the account's. ALL must be on the allowlist, so a signed-in stranger cannot pass by typing
   * the owner's address. `undefined` on a quote, which carries none: the allowlist is then
   * decided at booking create and again at payment start.
   */
  buyerEmails?: (string | null | undefined)[];
}

/**
 * The refusals that need no database: everything except the daily cap.
 *
 * Order is fixed, so a quote and the booking that follows list the same codes.
 */
export function pilotSaleBlockers(
  config: PilotConfig,
  sale: PilotSale,
  /**
   * `beforePrice` leaves out the order cap, for booking create's first pass: it runs before the
   * cinema-policy refusal, so a cart both refuse is refused with the pilot's code, as its quote
   * was, and before the total (which the cap needs) exists.
   */
  phase: 'all' | 'beforePrice' = 'all',
): PilotBlocker[] {
  if (config.mode === 'off') return [];
  if (!config.valid) return ['PILOT_MISCONFIGURED'];
  const l = config.limits;
  const out: PilotBlocker[] = [];
  if (!l.organizationIds.includes(sale.organizationId)) out.push('PILOT_ORGANIZER_NOT_ALLOWED');
  if (l.gaOnly && (sale.reservedSeating || sale.cinema)) out.push('PILOT_RESERVED_SEATING');
  if (!l.currencies.includes(sale.currency.toUpperCase())) out.push('PILOT_CURRENCY');
  const charged = sale.totalMinor > 0;
  if (
    sale.paymentMethod === 'CASH' ||
    (charged && !l.providers.includes((sale.provider ?? '').toLowerCase()))
  ) {
    out.push('PILOT_PROVIDER');
  }
  if (phase === 'all' && sale.totalMinor > l.maxOrderMinor) out.push('PILOT_ORDER_LIMIT');
  if (
    l.buyerEmails.length > 0 &&
    sale.buyerEmails !== undefined &&
    (sale.buyerEmails.length === 0 ||
      sale.buyerEmails.some((e) => !l.buyerEmails.includes((e ?? '').trim().toLowerCase())))
  ) {
    out.push('PILOT_BUYER_NOT_ALLOWED');
  }
  return out;
}

/** India has no daylight saving, so the offset is a constant. */
const KOLKATA_OFFSET_MS = (5 * 60 + 30) * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

/** The Asia/Kolkata calendar day containing `now`, as a UTC [start, end) range. */
export function kolkataDay(now: Date): { start: Date; end: Date; label: string } {
  const local = now.getTime() + KOLKATA_OFFSET_MS;
  const startLocal = Math.floor(local / DAY_MS) * DAY_MS;
  const start = new Date(startLocal - KOLKATA_OFFSET_MS);
  return {
    start,
    end: new Date(start.getTime() + DAY_MS),
    label: new Date(startLocal).toISOString().slice(0, 10),
  };
}
