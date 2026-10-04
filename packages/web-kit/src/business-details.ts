/**
 * The real-world facts about the business behind the storefront: who to contact, and how.
 *
 * ── WHY THIS FILE EXISTS ───────────────────────────────────────────────────────────────
 * These details were invented. The storefront shipped `support@eticketsgo.example`, a phone
 * number of `+00 0000 000000`, an office in a city the company does not work from, and a
 * contact form whose success panel said "we'll get back to you soon" while posting to a
 * `mailto:` on a domain reserved by RFC 2606 - one that can never resolve, anywhere, ever.
 *
 * A plausible support address that nobody reads is worse for a customer than a visibly absent
 * one. Somebody whose card was charged twice writes to it, believes the promise, and waits.
 * An absent one at least sends them looking for a channel that exists.
 *
 * So every field here starts as `null`, meaning NOT YET PUBLISHED, and the pages derive what
 * they show from what is actually set. Nothing in this file may be guessed: a contact address,
 * a registered office and a support window are commitments the business makes, and only the
 * business can make them.
 *
 * ── HOW TO PUBLISH THEM ────────────────────────────────────────────────────────────────
 * Replace a `null` with the real value. That is the whole procedure - every surface reads from
 * here, so there is no second place to remember. While ANY contact field is still null the
 * storefront keeps saying so, and that notice disappears on its own once they are filled in.
 */

/** A detail that is either published, or honestly absent. Never a plausible-looking stand-in. */
type Published = string | null;

export interface BusinessDetails {
  /** The entity that takes the money, as it appears on the receipt. */
  legalName: Published;
  /** Where a customer with a problem writes. The one field no storefront should ship without. */
  supportEmail: Published;
  /** Where an organizer who sells with us writes. */
  organizerEmail: Published;
  salesEmail: Published;
  partnershipsEmail: Published;
  mediaEmail: Published;
  /** In full international form, so it is dialable from outside the country. */
  supportPhone: Published;
  /** The registered office. A city alone is not an address. */
  postalAddress: Published;
  /** When somebody can expect an answer, with the timezone named. */
  supportHours: Published;
}

/**
 * NOTHING HERE IS PUBLISHED YET. Each `null` is a decision the business owner has to make.
 *
 * Do not fill one in to make a page look finished, or to make a launch check pass. A wrong
 * value here is strictly worse than the empty one it replaced, because the empty one is honest.
 */
export const BUSINESS_DETAILS: BusinessDetails = {
  legalName: null,
  supportEmail: null,
  organizerEmail: null,
  salesEmail: null,
  partnershipsEmail: null,
  mediaEmail: null,
  supportPhone: null,
  postalAddress: null,
  supportHours: null,
};

/**
 * The fields a customer needs before they can reasonably be asked to pay.
 *
 * Deliberately narrower than the whole interface. A media address is marketing; somewhere to
 * write when a payment goes wrong is not optional, and neither is knowing who was paid.
 */
export const CUSTOMER_ESSENTIAL_DETAILS: ReadonlyArray<keyof BusinessDetails> = [
  'legalName',
  'supportEmail',
];

/** Which details are still unpublished, in a form a person can be handed. */
export function missingBusinessDetails(
  details: BusinessDetails = BUSINESS_DETAILS,
): ReadonlyArray<keyof BusinessDetails> {
  return (Object.keys(details) as Array<keyof BusinessDetails>).filter(
    (k) => details[k] === null || details[k]?.trim() === '',
  );
}

/**
 * Whether the storefront must still tell visitors that its contact details are not real.
 *
 * This drives the notice rather than a hardcoded string, so the disclosure cannot outlive the
 * problem it describes - and, more importantly, cannot be deleted while the problem remains.
 */
export function needsPlaceholderNotice(details: BusinessDetails = BUSINESS_DETAILS): boolean {
  return missingBusinessDetails(details).length > 0;
}

/** Whether a customer could get help if a payment went wrong. */
export function canReachSupport(details: BusinessDetails = BUSINESS_DETAILS): boolean {
  return CUSTOMER_ESSENTIAL_DETAILS.every((k) => {
    const v = details[k];
    return typeof v === 'string' && v.trim() !== '';
  });
}

/**
 * Domains that can never receive mail, and the shapes a placeholder takes.
 *
 * `example`, `test`, `invalid` and `localhost` are reserved by RFC 2606 and RFC 6761 precisely
 * so they cannot be registered. An address on one is not "a detail to fix later" - it is an
 * address that is guaranteed to fail, which is why it is checked rather than trusted.
 */
const UNREACHABLE = [
  /@(?:[\w-]+\.)*example(?:\.[a-z]{2,})?$/i,
  /@(?:[\w-]+\.)*(?:test|invalid|localhost)$/i,
  /\bexample\.(?:com|org|net)\b/i,
  /placeholder/i,
  /\+00[\s-]?0000/,
  /\bTBD\b|\bTODO\b|\bXXX\b/,
];

/**
 * Why a published value cannot be used, or null if it is fine.
 *
 * Exported so the storefront refuses to render a value of this shape even if one is committed:
 * the guard is in the code path, not only in a test somebody can forget to run.
 */
export function unreachableReason(value: string): string | null {
  const hit = UNREACHABLE.find((re) => re.test(value));
  return hit ? `matches a reserved or placeholder pattern (${hit.source})` : null;
}

/** A detail to display, or null - never a value that is known to be undeliverable. */
export function publishedDetail(value: Published): string | null {
  if (value === null || value.trim() === '') return null;
  return unreachableReason(value) === null ? value : null;
}
