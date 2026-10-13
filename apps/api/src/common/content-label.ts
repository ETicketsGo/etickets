/**
 * Is this listing curated demo content, or leftover test data?
 *
 * ── WHY ────────────────────────────────────────────────────────────────────────────
 * QA has to keep its certification fixtures ("Test Event 1712...", "K-TEST ..."), and it also
 * has to look good in front of a person. Deleting the fixtures to improve a screenshot would
 * destroy evidence, so instead both kinds stay and each one SAYS what it is: DEMO for an
 * organization named in DEMO_ORGANIZATION_IDS, TEST for everything else.
 *
 * ── PRODUCTION IS INERT ─────────────────────────────────────────────────────────────
 * In PRODUCTION the label is always null, whatever DEMO_ORGANIZATION_IDS says: a real
 * organizer's real event must never be stamped "Test event" because of a stray setting. The
 * rule is keyed on APP_ENV (not NODE_ENV: QA and UAT also run with NODE_ENV=production).
 * Read at call time so a test can change it, and so there is nothing to wire into the
 * services' constructors.
 */
export type ContentLabel = 'DEMO' | 'TEST';

type Env = Record<string, string | undefined>;

export interface ContentLabelPolicy {
  /** False in PRODUCTION: nothing is labelled and nothing is reordered. */
  enabled: boolean;
  demoOrganizationIds: ReadonlySet<string>;
}

export function contentLabelPolicy(env: Env = process.env): ContentLabelPolicy {
  const appEnv = (env.APP_ENV ?? 'LOCAL').trim().toUpperCase();
  if (appEnv === 'PRODUCTION') return { enabled: false, demoOrganizationIds: new Set() };
  const ids = (env.DEMO_ORGANIZATION_IDS ?? '')
    .split(',')
    .map((id) => id.trim())
    .filter(Boolean);
  return { enabled: true, demoOrganizationIds: new Set(ids) };
}

/** DEMO, TEST, or null (always null in PRODUCTION). */
export function contentLabelFor(
  organizationId: string | null | undefined,
  policy: ContentLabelPolicy = contentLabelPolicy(),
): ContentLabel | null {
  if (!policy.enabled) return null;
  return organizationId && policy.demoOrganizationIds.has(organizationId) ? 'DEMO' : 'TEST';
}

/**
 * Curated demo content first, test data after it. STABLE, so each group keeps the order the
 * caller already had (newest, best-ranked), and it never drops anything: TEST is shown last,
 * not hidden. A no-op when nothing carries a label (PRODUCTION).
 */
export function demoFirst<T extends { contentLabel?: ContentLabel | null }>(items: T[]): T[] {
  if (!items.some((i) => i.contentLabel === 'DEMO')) return items;
  return [
    ...items.filter((i) => i.contentLabel === 'DEMO'),
    ...items.filter((i) => i.contentLabel !== 'DEMO'),
  ];
}
