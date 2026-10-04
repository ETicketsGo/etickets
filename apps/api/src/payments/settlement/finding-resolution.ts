/**
 * What an authorized operator must supply to close a money exception.
 *
 * ── RESOLUTION IS A DISPOSITION, NOT A CORRECTION ──────────────────────────────────────
 * Resolving a finding means a person has decided how this exception should be treated. It does
 * NOT mean the ledger has been changed until it looks right. Nothing in this module or its
 * caller can send money, refund money, reverse money, or alter an entitlement, a released amount
 * or a transferred amount - and that is enforced by what those modules are given, not by a rule
 * somebody has to remember.
 *
 * If a financial correction is genuinely needed, it goes through an explicit financial operation
 * with its own authority. Closing the exception and moving the money are deliberately two acts.
 *
 * ── WHY EVIDENCE IS CONDITIONAL ────────────────────────────────────────────────────────
 * Two of these dispositions assert something the PROVIDER did. An assertion about a provider
 * that cites nothing is indistinguishable from a guess, and a guess recorded as a resolution is
 * worse than an open finding, because it stops anybody looking again.
 *
 * The other two assert nothing about the provider at all. `SETTLED_OUTSIDE_PLATFORM` says money
 * reached the organizer by some other route; `CANNOT_ESTABLISH` says nobody could find out.
 * Demanding a provider reference for either would force an operator to invent one.
 */

export const FINDING_RESOLUTIONS = [
  'PROVIDER_CONFIRMED_SENT',
  'PROVIDER_CONFIRMED_NOT_SENT',
  'SETTLED_OUTSIDE_PLATFORM',
  'CANNOT_ESTABLISH',
] as const;

export type FindingResolution = (typeof FINDING_RESOLUTIONS)[number];

/** The dispositions that claim a provider-observed fact, and therefore must cite one. */
const CLAIMS_PROVIDER_FACT = new Set<FindingResolution>([
  'PROVIDER_CONFIRMED_SENT',
  'PROVIDER_CONFIRMED_NOT_SENT',
]);

export function claimsProviderFact(resolution: FindingResolution): boolean {
  return CLAIMS_PROVIDER_FACT.has(resolution);
}

export interface ResolutionRequest {
  resolution: FindingResolution;
  /** Always required. The next reader is a person, not a machine. */
  note?: string | null;
  /** The reference a person actually saw, where the disposition claims one. */
  evidenceRef?: string | null;
}

export type ResolutionCheck =
  { ok: true; note: string; evidenceRef: string | null } | { ok: false; reason: string };

/** The shortest a reason can be and still mean anything to whoever reads it next. */
const MIN_NOTE = 10;

/**
 * Whether this disposition may be recorded, as a pure function.
 *
 * Separate from the service so the policy can be read, argued with and tested without a database
 * or an HTTP request in the way.
 */
export function checkResolution(req: ResolutionRequest): ResolutionCheck {
  if (!FINDING_RESOLUTIONS.includes(req.resolution)) {
    return { ok: false, reason: 'Unknown resolution.' };
  }

  const note = (req.note ?? '').trim();
  if (note.length < MIN_NOTE) {
    return {
      ok: false,
      reason: `A reason is required, and it has to say something - at least ${MIN_NOTE} characters.`,
    };
  }

  const evidenceRef = (req.evidenceRef ?? '').trim() || null;
  if (claimsProviderFact(req.resolution) && !evidenceRef) {
    return {
      ok: false,
      reason:
        'This resolution states what the provider did, so it must cite the reference you saw. ' +
        'If you cannot establish it, use CANNOT_ESTABLISH instead.',
    };
  }

  return { ok: true, note: note.slice(0, 1_000), evidenceRef: evidenceRef?.slice(0, 200) ?? null };
}
