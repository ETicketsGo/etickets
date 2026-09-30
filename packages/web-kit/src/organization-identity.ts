/**
 * How to name an organization on screen when its name is not unique.
 *
 * ── THE DEFECT THIS EXISTS FOR ─────────────────────────────────────────────────────
 * The organizer switcher printed `org.name` and nothing else. A QA account held two
 * organizations both called "DeepTrics", and the dropdown offered them as two identical lines.
 * An organizer picking the wrong one does not find out: they price a show, publish it, take money
 * and settle it against an entity they did not intend, and every screen afterwards agrees with
 * the wrong choice. There is no error to read and nothing to undo.
 *
 * ── WHY THE SET DECIDES, NOT THE ORGANIZATION ──────────────────────────────────────
 * Ambiguity is a property of the LIST, not of one row, so this takes the whole list. A single
 * "DeepTrics" needs no qualifier; two need whatever tells them apart. Qualifying every row
 * regardless would trade one problem for a wall of repeated words - the switcher has to stay
 * readable at a glance, because it is read while doing something else.
 *
 * ── WHY A QUALIFIER IS ONLY USED WHEN IT ACTUALLY QUALIFIES ────────────────────────
 * Appending "India" to two organizations that are both in India helps nobody and reads as
 * information. So a candidate is used only when this organization's value for it differs from
 * EVERY namesake's. Where two of three namesakes share a city, the city is rejected for both of
 * them and the next candidate is tried - a qualifier that is true but not distinguishing is worse
 * than none, because it looks like an answer.
 *
 * The slug is last and is the guarantee. It is unique in the schema, so there is always a correct
 * answer and this never returns two identical labels.
 */

/** Only the fields naming needs. Anything with these can be labelled. */
export interface OrganizationIdentityInput {
  id: string;
  name: string;
  slug: string;
  legalName?: string | null;
  registeredCity?: string | null;
  registeredRegion?: string | null;
  registeredCountry?: string | null;
  legalEntityType?: string | null;
  /** The signed-in member's role in THIS organization. */
  myRole?: string | null;
}

export interface OrganizationIdentity {
  id: string;
  /** The name the organizer thinks in. Always the name, never rewritten. */
  primary: string;
  /**
   * What tells this one apart from its namesakes, or null when the name already does.
   *
   * Null is meaningful: it says "this name is unambiguous here", which is why the switcher can
   * stay one line per organization in the ordinary case.
   */
  secondary: string | null;
  /** Which field the qualifier came from, so a caller can render or test it deliberately. */
  secondarySource:
    'city' | 'region' | 'legalName' | 'entityType' | 'country' | 'role' | 'slug' | null;
  /** One string, for a native `<option>`, which cannot hold two lines. */
  label: string;
}

const blank = (value?: string | null): boolean => !value || !value.trim();

/**
 * A role as a person says it.
 *
 * The same transformation the invitation page already uses (`ORGANIZER_OWNER` -> "organizer
 * owner"), rather than a second map of hand-written labels that would drift from it.
 */
export function humanRole(role?: string | null): string {
  if (blank(role)) return '';
  return role!.replaceAll('_', ' ').toLowerCase();
}

/** The qualifiers, best first. Each reads as something an organizer would say about a business. */
const CANDIDATES: {
  source: NonNullable<OrganizationIdentity['secondarySource']>;
  of: (org: OrganizationIdentityInput) => string | null | undefined;
}[] = [
  // Where it operates is how people actually tell two branches of one brand apart.
  { source: 'city', of: (o) => o.registeredCity },
  { source: 'region', of: (o) => o.registeredRegion },
  // The registered entity: two trading names can be identical where the legal names are not.
  { source: 'legalName', of: (o) => o.legalName },
  { source: 'entityType', of: (o) => o.legalEntityType },
  { source: 'country', of: (o) => o.registeredCountry },
  // Last of the meaningful ones: "you are an owner here and staff there" is a real difference.
  { source: 'role', of: (o) => humanRole(o.myRole) },
  // Unique in the schema, so this always resolves. Never pretty; always correct.
  { source: 'slug', of: (o) => o.slug },
];

/**
 * Name every organization in a list so that no two labels are the same.
 *
 * Returns one identity per input, in the same order.
 */
export function organizationIdentities(
  orgs: readonly OrganizationIdentityInput[],
): OrganizationIdentity[] {
  const sameName = new Map<string, OrganizationIdentityInput[]>();
  for (const org of orgs) {
    const key = org.name.trim().toLowerCase();
    const bucket = sameName.get(key);
    if (bucket) bucket.push(org);
    else sameName.set(key, [org]);
  }

  return orgs.map((org) => {
    const namesakes = (sameName.get(org.name.trim().toLowerCase()) ?? []).filter(
      (o) => o.id !== org.id,
    );
    if (namesakes.length === 0) {
      return {
        id: org.id,
        primary: org.name,
        secondary: null,
        secondarySource: null,
        label: org.name,
      };
    }

    for (const candidate of CANDIDATES) {
      const mine = candidate.of(org);
      if (blank(mine)) continue;
      const value = mine!.trim();
      /*
        A qualifier that repeats the name is not information - except the slug, which is the
        guarantor and must always apply.

        Found on real data, not invented: a QA organization called "DeepTrics" also has
        `legalName` "DeepTrics", so the first draft rendered "DeepTrics — DeepTrics". Distinct
        from its namesake, and unreadable.

        Exempting the slug is not a nicety. Slugs are derived FROM names, so a one-word name
        matches its own slug ("DeepTrics" / "deeptrics") - skipping it there dropped the last
        candidate, returned no qualifier at all, and put the duplicate labels straight back. The
        test that asserts the slug fallback caught it immediately.
      */
      if (candidate.source !== 'slug' && value.toLowerCase() === org.name.trim().toLowerCase()) {
        continue;
      }
      // Distinguishing means differing from EVERY namesake, not merely being present.
      const clashes = namesakes.some((other) => {
        const theirs = candidate.of(other);
        return !blank(theirs) && theirs!.trim().toLowerCase() === value.toLowerCase();
      });
      if (clashes) continue;
      return {
        id: org.id,
        primary: org.name,
        secondary: value,
        secondarySource: candidate.source,
        label: `${org.name} — ${value}`,
      };
    }

    /*
      Unreachable while `slug` is unique, which the schema enforces. Kept as the name alone
      rather than a thrown error: a switcher that refuses to render is worse than one that is
      briefly ambiguous, and the caller has no way to fix the data from here.
    */
    return {
      id: org.id,
      primary: org.name,
      secondary: null,
      secondarySource: null,
      label: org.name,
    };
  });
}

/** One organization's identity, given the list it sits in. */
export function organizationIdentity(
  org: OrganizationIdentityInput,
  within: readonly OrganizationIdentityInput[],
): OrganizationIdentity {
  const all = within.some((o) => o.id === org.id) ? within : [...within, org];
  return organizationIdentities(all).find((i) => i.id === org.id)!;
}

/**
 * How to name the active organization inside a sentence that is about to do something.
 *
 * Used by confirmations for money, publishing and deletion. It always carries the qualifier when
 * there is one, even where the switcher would have left it off, because the cost of being wrong
 * is different: a mis-read dropdown is a moment's confusion, a settlement against the wrong
 * entity is not something the organizer can take back.
 */
export function activeOrganizationSentenceName(
  org: OrganizationIdentityInput,
  within: readonly OrganizationIdentityInput[],
): string {
  const identity = organizationIdentity(org, within);
  return identity.secondary ? `${identity.primary} (${identity.secondary})` : identity.primary;
}
