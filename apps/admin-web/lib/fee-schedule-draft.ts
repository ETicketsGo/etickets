import { ApiRequestError, type FeeScheduleBand, type FeeScheduleIssue } from '@eticketsgo/web-kit';

/**
 * The draft fee schedule editor, kept pure so it is tested without a browser.
 *
 * ── AMOUNTS ARE TYPED AS A PERSON SAYS THEM ────────────────────────────────────────
 * The one-band editor asked for MINOR units ("10000" for $100.00). A band shown as "$100.00"
 * in the table was edited as "10000" in the form, so one extra or missing zero moved a boundary
 * by ten times, and the refusal then named amounts nobody had typed. Here every amount is typed
 * in the currency's own units ("100.00") and converted once, by `parseMajor`.
 *
 * ── EDITS ARE LOCAL ─────────────────────────────────────────────────────────────────
 * Rows are edited in the browser and sent as one list when the admin saves. Nothing is sent per
 * keystroke, and nothing is live until a publish.
 */

export type FeeType = FeeScheduleBand['feeType'];

/** One row as the form holds it: strings, so a half-typed value does not fight the input. */
export interface DraftRow {
  key: string;
  sourceId: string | null;
  from: string;
  /** Empty is "and above". */
  to: string;
  feeType: FeeType;
  /** FLAT: per order. COMBINED and FIXED_PER_TICKET: per paid ticket. */
  fee: string;
  /** PERCENT and COMBINED: "5" or "2.5". */
  percent: string;
  /** Optional whole-order limits (not FLAT). Empty is no limit. */
  minFee: string;
  maxFee: string;
  country: string;
  region: string;
  active: boolean;
}

/** Digits after the decimal point for a currency: 2 for USD and INR, 0 for JPY. */
export function currencyDigits(currency: string): number {
  try {
    return (
      new Intl.NumberFormat('en-US', { style: 'currency', currency }).resolvedOptions()
        .maximumFractionDigits ?? 2
    );
  } catch {
    return 2;
  }
}

/**
 * "100", "100.5", "1,000.00" -> minor units. Null when it is not an amount in this currency:
 * empty, negative, not a number, or more decimal places than the currency has.
 */
export function parseMajor(raw: string, currency: string): number | null {
  const text = raw.trim().replace(/,/g, '');
  if (text === '') return null;
  const digits = currencyDigits(currency);
  const pattern = digits > 0 ? new RegExp(`^\\d+(\\.\\d{1,${digits}})?$`) : /^\d+$/;
  if (!pattern.test(text)) return null;
  const [whole, fraction = ''] = text.split('.');
  const minor = Number(whole) * 10 ** digits + Number(fraction.padEnd(digits, '0') || '0');
  return Number.isSafeInteger(minor) ? minor : null;
}

/** Minor units -> the text an amount field shows: 10000 -> "100.00". No symbol, no commas. */
export function formatMajor(minor: number | null, currency: string): string {
  if (minor === null) return '';
  const digits = currencyDigits(currency);
  return (minor / 10 ** digits).toFixed(digits);
}

/** "5" or "2.5" -> basis points. Null when it is not a percentage above 0 and up to 100. */
export function percentToBps(raw: string): number | null {
  const text = raw.trim();
  if (!/^\d+(\.\d{1,2})?$/.test(text)) return null;
  const bps = Math.round(Number(text) * 100);
  return bps >= 1 && bps <= 10_000 ? bps : null;
}

export function rowFromBand(b: FeeScheduleBand, currency: string): DraftRow {
  const percentText = b.feePercentBps == null ? '' : String(b.feePercentBps / 100);
  return {
    key: b.key,
    sourceId: b.sourceId,
    from: formatMajor(b.minMinor, currency),
    to: formatMajor(b.maxMinor, currency),
    feeType: b.feeType,
    fee: b.feeType === 'PERCENT' ? '' : formatMajor(b.feeMinor, currency),
    percent: percentText,
    minFee: formatMajor(b.minFeeMinor, currency),
    maxFee: formatMajor(b.maxFeeMinor, currency),
    country: b.country,
    region: b.region,
    active: b.active,
  };
}

/**
 * A row as the API stores it, or the reasons it cannot be read yet. These are only about the
 * typing ("enter an amount"); whether the schedule is whole is the API's check.
 */
export function bandFromRow(
  row: DraftRow,
  currency: string,
): { band: FeeScheduleBand | null; problems: string[] } {
  const problems: string[] = [];
  const example = formatMajor(10 * 10 ** currencyDigits(currency), currency);
  const amount = (raw: string, what: string, optional: boolean): number | null => {
    if (raw.trim() === '') {
      if (!optional) problems.push(`Enter ${what}, for example ${example}.`);
      return null;
    }
    const v = parseMajor(raw, currency);
    if (v === null) problems.push(`${capitalise(what)} must be an amount, for example ${example}.`);
    return v;
  };
  const minMinor = amount(row.from, 'the starting amount', false);
  const maxMinor = amount(row.to, 'the end amount', true);
  const needsFee = row.feeType !== 'PERCENT';
  const needsPercent = row.feeType === 'PERCENT' || row.feeType === 'COMBINED';
  const feeMinor = needsFee ? amount(row.fee, 'the fee', false) : 0;
  const bps = needsPercent ? percentToBps(row.percent) : null;
  if (needsPercent && bps === null) {
    problems.push('Enter a percentage above 0 and up to 100, for example 5 or 2.5.');
  }
  const limits = row.feeType !== 'FLAT';
  const minFeeMinor = limits ? amount(row.minFee, 'the minimum fee', true) : null;
  const maxFeeMinor = limits ? amount(row.maxFee, 'the maximum fee', true) : null;
  if (minMinor !== null && maxMinor !== null && maxMinor <= minMinor) {
    problems.push(
      'The end amount must be more than the starting amount. Leave it empty for "and above".',
    );
  }
  if (problems.length > 0 || minMinor === null || feeMinor === null)
    return { band: null, problems };
  return {
    band: {
      key: row.key,
      sourceId: row.sourceId,
      minMinor,
      maxMinor,
      feeType: row.feeType,
      feeMinor,
      feePercentBps: needsPercent ? bps : null,
      minFeeMinor,
      maxFeeMinor,
      country: row.country || '*',
      region: row.region || '*',
      active: row.active,
    },
    problems: [],
  };
}

/** Every row as a band, or null while any row cannot be read (the form shows why). */
export function bandsFromRows(rows: DraftRow[], currency: string): FeeScheduleBand[] | null {
  const out: FeeScheduleBand[] = [];
  for (const r of rows) {
    const { band } = bandFromRow(r, currency);
    if (!band) return null;
    out.push(band);
  }
  return out;
}

let counter = 0;
/**
 * A new row. It starts one minor unit after the highest end amount in the same place, so adding
 * the next band after "$0.00 - $99.99" offers "$100.00".
 */
export function newRow(rows: DraftRow[], currency: string, country: string): DraftRow {
  const ends = rows
    .filter((r) => r.country === country && r.region === '*')
    .map((r) => parseMajor(r.to, currency))
    .filter((v): v is number => v !== null);
  const from = ends.length ? Math.max(...ends) + 1 : 0;
  return {
    key: `new-${Date.now().toString(36)}-${++counter}`,
    sourceId: null,
    from: formatMajor(from, currency),
    to: '',
    feeType: 'FLAT',
    fee: '',
    percent: '',
    minFee: '',
    maxFee: '',
    country,
    region: '*',
    active: true,
  };
}

/** Rows in the order a person reads a schedule: by place, then by starting amount. */
export function sortRows(rows: DraftRow[], currency: string): DraftRow[] {
  const start = (r: DraftRow) => parseMajor(r.from, currency) ?? Number.MAX_SAFE_INTEGER;
  return [...rows].sort(
    (a, b) =>
      a.country.localeCompare(b.country) || a.region.localeCompare(b.region) || start(a) - start(b),
  );
}

/** The issues the API returned with a refused publish, if it returned any. */
export function issuesFromError(err: unknown): FeeScheduleIssue[] | null {
  if (!(err instanceof ApiRequestError)) return null;
  const issues = (err.details as { issues?: unknown } | undefined)?.issues;
  return Array.isArray(issues) ? (issues as FeeScheduleIssue[]) : null;
}

/**
 * The ONE sentence shown for a failed operation. Plain English, never the server's internals:
 * a 5xx, a network failure or a request-shape refusal says what happened and that nothing
 * changed; a refusal the API words for people (a stale draft, a schedule with problems) is
 * shown as the API wrote it.
 */
export function failureMessage(err: unknown, action: string): string {
  if (!(err instanceof ApiRequestError)) {
    return `Could not ${action}: the server could not be reached. Nothing was changed. Check your connection and try again.`;
  }
  if (err.status === undefined || err.status >= 500) {
    return `Could not ${action}: something went wrong on our side. Nothing was changed. Try again in a moment.`;
  }
  if (err.code === 'VALIDATION_FAILED') {
    return `Could not ${action}: some values in the draft are not valid. Check the rows marked in red.`;
  }
  if (err.code === 'MFA_STEP_UP_REQUIRED') {
    return `Could not ${action}: confirm it is you first. Nothing was changed.`;
  }
  if (err.status === 401) return 'Your session has ended. Sign in again. Nothing was changed.';
  if (err.status === 403) {
    return `Could not ${action}: you do not have the Platform configuration duty.`;
  }
  return err.message || `Could not ${action}. Nothing was changed.`;
}

function capitalise(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}
