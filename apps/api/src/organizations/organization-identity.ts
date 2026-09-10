/**
 * Whether an organization has said who it legally is, and whether it is pretending to be
 * somebody else.
 *
 * ── WHY THIS EXISTS ────────────────────────────────────────────────────────────────
 * Anybody with an account can register an organization. The important gate was already
 * there — a new one is PENDING and cannot sell a ticket until a human approves it — but the
 * human was approving on a name and an email address alone.
 *
 * That is thin for a decision whose consequence is "this party may now take money from the
 * public under this name". Two cheap facts make it much less thin: whether they have
 * declared a legal identity, and whether the name they chose is one somebody else is already
 * trading under.
 *
 * ── WHY NEITHER OF THESE BLOCKS REGISTRATION ───────────────────────────────────────
 * Both are inputs to a review, not verdicts. A name collision is frequently innocent — two
 * real businesses share a name often enough — and refusing at registration would teach a
 * squatter to try again with a variation while turning away the honest case entirely. The
 * platform's answer to "is this really you" is a person looking, and these make that looking
 * cheaper.
 */

/** The legal facts an organization must have declared before it may be approved. */
export interface LegalIdentity {
  legalName?: string | null;
  taxRegistrationKind?: string | null;
  taxRegistrationNumber?: string | null;
}

export interface IdentityVerdict {
  complete: boolean;
  /** Field names that are missing, in the vocabulary a reviewer sees. Never a schema path. */
  missing: string[];
}

/**
 * What is still missing before this organization can be approved.
 *
 * Deliberately just presence, not validity. This platform cannot check a GSTIN against a
 * government register, and a regex that accepted the right SHAPE would be worse than nothing:
 * it would read as verification to whoever saw it pass, while proving only that somebody can
 * count characters.
 */
export function checkLegalIdentity(org: LegalIdentity): IdentityVerdict {
  const missing: string[] = [];
  if (!org.legalName?.trim()) missing.push('legal name');
  if (!org.taxRegistrationKind?.trim()) missing.push('tax registration type');
  if (!org.taxRegistrationNumber?.trim()) missing.push('tax registration number');
  return { complete: missing.length === 0, missing };
}

/**
 * Words that appear in company names everywhere and distinguish nothing.
 *
 * Stripped before comparison so "PVR Cinemas Pvt Ltd" and "PVR Cinemas" are recognised as
 * the same claim on a name, which is exactly the case a reviewer needs raised.
 */
const NOISE = new Set([
  'pvt',
  'private',
  'ltd',
  'limited',
  'llp',
  'inc',
  'incorporated',
  'corp',
  'corporation',
  'co',
  'company',
  'the',
  'and',
]);

/**
 * A name reduced to what somebody would recognise it by.
 *
 * Lower-cased, punctuation and diacritics dropped, noise words removed, the rest sorted —
 * so word order does not hide a collision either. "Cinemas PVR" and "PVR Cinemas" are the
 * same claim.
 */
export function normalizeOrgName(name: string): string {
  const raw = name
    .normalize('NFKD')
    // Diacritics: "Café" and "Cafe" are the same name to everyone except a string comparison.
    .replace(/\p{Diacritic}/gu, '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]+/g, ' ')
    .split(/\s+/)
    .filter(Boolean);

  /*
    Consecutive single characters are initials, and are joined back up.

    Dropping the punctuation from "P.V.R. Cinemas" leaves three one-letter words, which no
    longer resemble "PVR Cinemas" at all — so the single cheapest way to dress up somebody
    else's name would have walked straight past this check. Only RUNS are joined: a stray
    initial elsewhere in a name is left where it is.
  */
  const joined: string[] = [];
  for (const word of raw) {
    const previous = joined[joined.length - 1];
    if (word.length === 1 && previous && previous.length <= 2 && /^[a-z]+$/.test(previous)) {
      joined[joined.length - 1] = previous + word;
      continue;
    }
    joined.push(word);
  }

  const words = joined.filter((w) => !NOISE.has(w));
  /*
    Everything was noise -- a name like "The Company Ltd". Falling back to the stripped
    original keeps such a name comparable to another one like it, instead of collapsing every
    such registration to the empty string and reporting them all as collisions with each other.
  */
  if (words.length === 0) return name.toLowerCase().replace(/[^a-z0-9]+/g, '');
  return words.sort().join(' ');
}

export interface NameCollision {
  organizationId: string;
  name: string;
  status: string;
  /** True when the normalised names are identical rather than merely close. */
  exact: boolean;
}

/**
 * Existing organizations whose name is a claim on the same identity.
 *
 * ── WHY ONLY EXACT-AFTER-NORMALISING, AND NOT A FUZZY DISTANCE ─────────────────────
 * An edit-distance threshold sounds better and behaves worse. Loose enough to catch "PVR"
 * against "PVRR" is loose enough to match half the short names on the platform, and a
 * reviewer who is shown five false collisions on every registration stops reading the field
 * — at which point it is worse than absent, because its presence implies the check happened.
 *
 * Normalising and comparing exactly catches the impersonation attempts that actually occur —
 * the same words, differently punctuated, differently ordered, with a legal suffix bolted on
 * — and reports nothing when there is nothing.
 */
export function findNameCollisions(
  name: string,
  others: readonly { id: string; name: string; status: string }[],
): NameCollision[] {
  const target = normalizeOrgName(name);
  if (!target) return [];
  return others
    .filter((o) => normalizeOrgName(o.name) === target)
    .map((o) => ({ organizationId: o.id, name: o.name, status: o.status, exact: true }));
}
