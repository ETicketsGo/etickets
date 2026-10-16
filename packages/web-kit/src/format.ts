/**
 * Money and date formatting.
 *
 * The implementations moved to @eticketsgo/shared-types so the mobile app renders
 * amounts identically to the web without a second copy of the INR rule.
 * They are re-exported here because ~200 call sites import them from web-kit, and a
 * package boundary is not worth churning those imports over. Behaviour is unchanged:
 * the locale and timeZone parameters shared-types adds are optional and default to
 * what this module always did.
 */
import {
  money,
  moneyFractionDigits,
  currencySymbol,
  dateTime,
  dateOnly,
  zoneAbbrev,
  venueZone,
  viewerTimeZone,
} from '@eticketsgo/shared-types';

export {
  money,
  moneyFractionDigits,
  currencySymbol,
  dateTime,
  dateOnly,
  titleCase,
  zoneAbbrev,
} from '@eticketsgo/shared-types';

/**
 * The formatters, bound to the reader's language.
 *
 * Every function keeps the exact signature of its module-level namesake, so switching a call
 * site is a change of where `money` comes from and nothing else. A locale passed explicitly
 * still wins; `undefined` in the locale slot means "the reader's language" rather than
 * "English".
 */
export interface LocaleFormat {
  /** The locale handed to `Intl`, or undefined when the English defaults apply. */
  readonly locale: string | undefined;
  money: typeof money;
  moneyFractionDigits: typeof moneyFractionDigits;
  currencySymbol: typeof currencySymbol;
  dateTime: typeof dateTime;
  dateOnly: typeof dateOnly;
  zoneAbbrev: typeof zoneAbbrev;
}

/** English: the module functions themselves, so the output cannot drift by a byte. */
const ENGLISH: LocaleFormat = {
  locale: undefined,
  money,
  moneyFractionDigits,
  currencySymbol,
  dateTime,
  dateOnly,
  zoneAbbrev,
};

/**
 * The currency's symbol in `locale`, never its bare ISO code when a real symbol exists.
 *
 * ── WHY NOT JUST `currencyDisplay: 'narrowSymbol'` ─────────────────────────────────
 * French CLDR has no symbol of its own for the rupee, so `Intl` in fr-CA prints
 * "1 039,60 INR" — correct, but not what a customer reads on a ticket. `narrowSymbol` fixes
 * that and breaks something worse: in fr-CA it prints USD as a bare "$", which in Quebec
 * means Canadian dollars. So the locale's own symbol is kept ("1 234,56 $ US" stays
 * unambiguous) and the narrow one is used only where the locale had nothing but the code.
 */
function localSymbolFix(currency: string, locale: string): string | null {
  if (currencySymbol(currency, locale) !== currency) return null;
  try {
    const narrow = new Intl.NumberFormat(locale, {
      style: 'currency',
      currency,
      currencyDisplay: 'narrowSymbol',
    })
      .formatToParts(0)
      .find((p) => p.type === 'currency')?.value;
    return narrow && narrow !== currency ? narrow : null;
  } catch {
    return null;
  }
}

function bound(locale: string): LocaleFormat {
  return {
    locale,
    money: (minor, currency = 'INR', explicit, fractionDigits) => {
      const target = explicit ?? locale;
      const text = money(minor, currency, target, fractionDigits);
      const symbol = minor == null ? null : localSymbolFix(currency, target);
      // Digits and separators never contain letters, so the code can only be the symbol.
      return symbol ? text.replace(currency, symbol) : text;
    },
    moneyFractionDigits: (amounts, currency, explicit) =>
      moneyFractionDigits(amounts, currency, explicit ?? locale),
    currencySymbol: (currency = 'INR', explicit) => {
      const target = explicit ?? locale;
      return localSymbolFix(currency, target) ?? currencySymbol(currency, target);
    },
    dateTime: (value, explicit, timeZone) => dateTime(value, explicit ?? locale, timeZone),
    dateOnly: (value, explicit, timeZone) => dateOnly(value, explicit ?? locale, timeZone),
    // The zone's name is deliberately not localized: "IST" / "GMT+5:30" is what the venue
    // prints, and it has to match the ticket in every language.
    zoneAbbrev,
  };
}

const CACHE = new Map<string, LocaleFormat>();

/**
 * The formatters for a UI locale (a next-intl locale such as `en` or `fr-CA`).
 *
 * ── WHY ENGLISH IS "NO LOCALE" RATHER THAN `en` ────────────────────────────────────
 * English money has never been formatted in `en`: INR uses en-IN (lakh grouping) and
 * everything else en-US, and dates use en-IN. Receipts, e2e money-footing assertions and
 * every existing test depend on those exact strings, so any English locale maps to the
 * defaults the module already applies. Every other language formats in its own locale —
 * French gets "1 039,60 ₹", "19 sept. 2026, 18 h 30".
 *
 * Deterministic for a given locale and time zone: nothing here reads the machine's locale,
 * so the server render and the hydrating client produce the same string.
 */
export function formatFor(uiLocale?: string | null): LocaleFormat {
  if (!uiLocale || uiLocale === 'en' || uiLocale.startsWith('en-')) return ENGLISH;
  let format = CACHE.get(uiLocale);
  if (!format) {
    format = bound(uiLocale);
    CACHE.set(uiLocale, format);
  }
  return format;
}

/**
 * The zone's short name an organizer would say: "IST", "CDT", "EST".
 *
 * Each English locale knows the names of its own region's zones and spells the rest as an
 * offset - en-US says "GMT+5:30" for India, en-IN says "IST" but "GMT-5" for Chicago. Both are
 * asked, and the first real name wins; an offset is the fallback, which is never wrong.
 */
export function zoneShortName(iso: string, zone: string): string {
  const names = ['en-US', 'en-IN'].map((locale) => {
    try {
      return (
        new Intl.DateTimeFormat(locale, { timeZone: zone, timeZoneName: 'short' })
          .formatToParts(new Date(iso))
          .find((p) => p.type === 'timeZoneName')?.value ?? ''
      );
    } catch {
      return '';
    }
  });
  return names.find((n) => n && !/^(GMT|UTC)/.test(n)) ?? (names[0] || zoneAbbrev(iso, zone));
}

/** Where a show is: anything that carries the venue's zone, or the zone itself. */
export type ShowPlace = { timezone?: string | null; country?: string | null } | string | null;

/**
 * A show or session start as the time AT THE VENUE, with the zone's short name:
 * "20 Nov 2026, 7:00 pm IST".
 *
 * -- THE DEFECT THIS EXISTS FOR ---------------------------------------------------------
 * `dateTime(startsAt)` with no zone formats in the READER's clock. On QA a Mountain-time
 * organizer read a 7:00 pm Bengaluru show as "20 Nov 2026, 6:30 am" on the bookings search
 * and in the check-in device list, with nothing on the screen saying whose clock that was.
 * Every console screen that names a show time uses this instead, so the console reads the
 * time the ticket prints, the storefront shows and the door staff work to.
 *
 * The zone is the venue's own, else the only zone its country has. When neither is known the
 * reader's clock is used and said to be theirs - never passed off as the venue's.
 */
export function timeAtVenue(
  value: string | Date | null | undefined,
  place: ShowPlace | undefined,
): string {
  if (!value) return '-';
  const zone =
    typeof place === 'string'
      ? place.trim() || null
      : venueZone(place?.timezone ?? null, place?.country ?? null);
  if (!zone) return `${dateTime(value, 'en-IN')} (your time)`;
  const iso = new Date(value).toISOString();
  const name = zoneShortName(iso, zone);
  const when = dateTime(value, 'en-IN', zone);
  return name ? `${when} ${name}` : when;
}

/**
 * When something HAPPENED - an audit line, a created-at, a last-seen - on the reader's own
 * clock, named: "16 Oct 2026, 9:12 am MDT".
 *
 * Not a show time, so it is not moved to any venue: "when did this refund get asked for" is
 * best read on the clock of the person asking. But it carries its zone's name, so it cannot be
 * mistaken for a venue time sitting next to one on the same screen.
 */
export function recordedAt(
  value: string | Date | null | undefined,
  zone: string = viewerTimeZone(),
): string {
  if (!value) return '-';
  const when = dateTime(value, 'en-IN', zone);
  const name = zoneShortName(new Date(value).toISOString(), zone);
  return name ? `${when} ${name}` : when;
}
