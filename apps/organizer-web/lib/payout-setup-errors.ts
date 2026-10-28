/**
 * What to tell an organizer when payout setup fails, from the API's error code.
 *
 * ── WHY THIS EXISTS ────────────────────────────────────────────────────────────────
 * "Set up payouts" showed whatever the API said, which was either "Something went wrong."
 * (a 500) or Stripe's own sentence about our platform account ("Stripe no longer recommends
 * Accounts v1 ... enable Accounts v1 support in the Dashboard"). Neither told the organizer
 * whether to try again, fix something, ask their owner or contact us. Each failure class now
 * has its own code (apps/api/src/common/errors.ts) and its own sentence here.
 *
 * ASCII only and plain English (house rule). Never a provider name, a product, a setting, a
 * stack trace or a raw server message for a server-side failure.
 */

/** The shape of an `ApiRequestError` this needs; read structurally so tests need no fetch. */
interface ApiFailure {
  code?: unknown;
  status?: unknown;
  message?: unknown;
  details?: unknown;
  correlationId?: unknown;
}

/** Organization fields the API may name, in the words the Settings page uses. */
const FIELD_WORDS: Record<string, string> = {
  registeredCountry: 'country of registration',
  contactEmail: 'contact email',
  legalName: 'legal name',
  legalEntityType: 'legal entity type',
};

export const PAYOUT_SETUP_MESSAGES = {
  COUNTRY_UNSUPPORTED:
    'Payout setup is not available for your country yet. Contact ETicketsGo support to find out when it will be.',
  NOT_CONFIGURED:
    'Payout setup is not switched on for this site yet. Contact ETicketsGo support. Nothing was changed.',
  OWNER_ONLY:
    'Only the owner of this organization can set up payouts. Ask your owner to do this step.',
  UNAVAILABLE:
    'The payout provider is not answering right now. Wait a few minutes, then try again.',
  NETWORK: 'We could not reach ETicketsGo. Check your connection, then try again.',
  FALLBACK: 'We could not start payout setup. Try again, or contact ETicketsGo support.',
} as const;

function fieldsOf(details: unknown): string[] {
  const fields = (details as { fields?: unknown } | null | undefined)?.fields;
  return Array.isArray(fields) ? fields.filter((f): f is string => typeof f === 'string') : [];
}

/** "Your organization details are incomplete: country of registration." plus where to fix it. */
export function incompleteDetailsMessage(fields: string[]): string {
  const words = fields.map((f) => FIELD_WORDS[f] ?? 'a required detail');
  const list = words.length ? Array.from(new Set(words)).join(', ') : 'a required detail';
  return `Your organization details are incomplete: ${list}. Add this in Settings, then try again.`;
}

/**
 * The sentence for a failed payout-setup request. Adds the support reference for server-side
 * failures, so a person who contacts us can be matched to the log line.
 */
export function payoutSetupErrorMessage(error: unknown): string {
  if (typeof TypeError !== 'undefined' && error instanceof TypeError) {
    // fetch() rejects with a TypeError when the network fails before any response.
    return PAYOUT_SETUP_MESSAGES.NETWORK;
  }
  const e = (typeof error === 'object' && error !== null ? error : {}) as ApiFailure;
  const code = typeof e.code === 'string' ? e.code : '';
  const status = typeof e.status === 'number' ? e.status : 0;
  const ref =
    typeof e.correlationId === 'string' && e.correlationId
      ? ` Reference: ${e.correlationId.slice(0, 8)}.`
      : '';

  switch (code) {
    case 'PAYOUT_COUNTRY_UNSUPPORTED':
      return PAYOUT_SETUP_MESSAGES.COUNTRY_UNSUPPORTED;
    case 'PAYMENT_PROVIDER_NOT_CONFIGURED':
      return PAYOUT_SETUP_MESSAGES.NOT_CONFIGURED + ref;
    case 'ORGANIZATION_DETAILS_INCOMPLETE':
      return incompleteDetailsMessage(fieldsOf(e.details));
    case 'TENANT_FORBIDDEN':
    case 'FORBIDDEN':
      return PAYOUT_SETUP_MESSAGES.OWNER_ONLY;
    case 'PAYMENT_PROVIDER_UNAVAILABLE':
    case 'PROVIDER_TIMEOUT':
    case 'RATE_LIMITED':
      return PAYOUT_SETUP_MESSAGES.UNAVAILABLE + ref;
    case 'ORGANIZATION_SUSPENDED':
      // The API's own sentence: it is written for organizers and says what to do.
      return typeof e.message === 'string' && e.message
        ? e.message
        : PAYOUT_SETUP_MESSAGES.FALLBACK;
  }
  if (status === 403) return PAYOUT_SETUP_MESSAGES.OWNER_ONLY;
  if (status >= 500 || status === 0) return PAYOUT_SETUP_MESSAGES.FALLBACK + ref;
  // A 4xx we did not foresee: the API's sentence is meant for the caller, but keep it ASCII-safe.
  const message = typeof e.message === 'string' ? e.message : '';
  return message && /^[\x20-\x7E]+$/.test(message) && message.length <= 300
    ? message
    : PAYOUT_SETUP_MESSAGES.FALLBACK;
}
