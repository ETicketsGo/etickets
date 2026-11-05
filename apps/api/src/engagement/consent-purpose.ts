/**
 * What a consent is FOR, and the pure rule that turns a person's history into an answer.
 *
 * ── HOW THIS RELATES TO `MarketingConsent` ─────────────────────────────────────────
 * `MarketingConsent` already answers "may the PLATFORM send this person marketing on this
 * channel", and the notification service reads it on every marketing send. Copying that
 * answer into a second table would give one person two answers that can disagree. So:
 *
 *   - MARKETING_EMAIL with no organization  -> lives in `MarketingConsent`, channel `email`.
 *     `CommunicationConsentService` writes and reads it THERE. It never writes a
 *     platform-wide MARKETING_EMAIL row into `CommunicationConsent`.
 *   - Anything scoped to ONE organizer      -> lives in `CommunicationConsent`, because
 *     `MarketingConsent` has no scope column and adding one would change what every
 *     existing row means.
 *
 * Both tables are append-only, both read "newest row wins, no row means no", and both feed
 * one merged history for the person (see `CommunicationConsentService.history`).
 */
export const ConsentPurpose = {
  /** Platform marketing email from ETicketsGo itself. Stored in `MarketingConsent`. */
  MARKETING_EMAIL: 'MARKETING_EMAIL',
  /** Email from one organizer about their new events. */
  ORGANIZER_UPDATES: 'ORGANIZER_UPDATES',
  /** Email from one organizer about presales and early access. */
  EARLY_ACCESS: 'EARLY_ACCESS',
  /** Email from one organizer with offers and discounts. */
  OFFERS: 'OFFERS',
} as const;
export type ConsentPurpose = (typeof ConsentPurpose)[keyof typeof ConsentPurpose];

/** The purposes that only make sense with an organizer attached. */
export const ORGANIZER_PURPOSES = [
  ConsentPurpose.ORGANIZER_UPDATES,
  ConsentPurpose.EARLY_ACCESS,
  ConsentPurpose.OFFERS,
] as const;
export type OrganizerPurpose = (typeof ORGANIZER_PURPOSES)[number];

export function isOrganizerPurpose(value: string): value is OrganizerPurpose {
  return (ORGANIZER_PURPOSES as readonly string[]).includes(value);
}

/** The fields of a consent row the rule below needs. Both tables map onto it. */
export interface ConsentRecord {
  purpose: string;
  organizationId: string | null;
  channel: string;
  granted: boolean;
  source: string;
  policyVersion: string | null;
  createdAt: Date;
}

export interface CurrentConsent {
  purpose: string;
  organizationId: string | null;
  channel: string;
  granted: boolean;
  /** Null when there is no row: the person never decided, which means NO. */
  decidedAt: Date | null;
  source: string | null;
  policyVersion: string | null;
}

/**
 * The current decision of ONE subject for one purpose, scope and channel.
 *
 * `rows` is that subject's history (any order). The newest matching row wins. No matching
 * row is "not granted" - silence is never consent.
 *
 * Pure on purpose: the same rule is applied to rows from either table, in a unit test with no
 * database, and in the audience count, and it cannot drift between them.
 */
export function currentConsent(
  rows: readonly ConsentRecord[],
  purpose: string,
  organizationId: string | null,
  channel = 'email',
): CurrentConsent {
  let latest: ConsentRecord | null = null;
  for (const row of rows) {
    if (row.purpose !== purpose) continue;
    if ((row.organizationId ?? null) !== (organizationId ?? null)) continue;
    if (row.channel !== channel) continue;
    // Ties on the timestamp go to the LATER row in the list, so a grant and a withdrawal
    // written in the same millisecond resolve to whichever was written second.
    if (!latest || row.createdAt.getTime() >= latest.createdAt.getTime()) latest = row;
  }
  return {
    purpose,
    organizationId: organizationId ?? null,
    channel,
    granted: latest?.granted ?? false,
    decidedAt: latest?.createdAt ?? null,
    source: latest?.source ?? null,
    policyVersion: latest?.policyVersion ?? null,
  };
}

/** The subject's history, newest first, optionally for one organizer. */
export function consentHistory(
  rows: readonly ConsentRecord[],
  filter: { organizationId?: string | null } = {},
): ConsentRecord[] {
  return rows
    .filter((r) =>
      filter.organizationId === undefined
        ? true
        : (r.organizationId ?? null) === (filter.organizationId ?? null),
    )
    .slice()
    .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
}
