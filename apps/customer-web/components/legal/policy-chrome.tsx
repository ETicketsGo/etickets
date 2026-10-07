import { Link } from '@/i18n/navigation';
import {
  POLICY_JURISDICTIONS,
  PLATFORM_OPERATOR,
  getApplicablePolicy,
  policyJurisdictionFor,
  type PolicyJurisdiction,
  type PolicyType,
} from '@eticketsgo/shared-types';

const REGION_NAME: Record<PolicyJurisdiction, string> = {
  US: 'the United States',
  IN: 'India',
  CA: 'Canada',
  GLOBAL: 'all other countries',
};

/** The label on the control, where a short noun reads better than a sentence fragment. */
const REGION_SHORT: Record<PolicyJurisdiction, string> = {
  US: 'United States',
  IN: 'India',
  CA: 'Canada',
  GLOBAL: 'All other countries',
};

/** `2026-10-06` as `October 6, 2026`. A customer should never have to read an ISO date. */
function readableDate(iso: string): string {
  const [y, m, d] = iso.split('-').map(Number);
  const month = [
    'January',
    'February',
    'March',
    'April',
    'May',
    'June',
    'July',
    'August',
    'September',
    'October',
    'November',
    'December',
  ][(m ?? 1) - 1];
  return `${month} ${d}, ${y}`;
}

/**
 * The one line of context above a legal document: which market it applies to, and since when.
 *
 * -- WHAT THIS DELIBERATELY DOES NOT SHOW ------------------------------------------------
 * The policy identifier. `TERMS/IN/v1` is how the registry and a consent record name a
 * document, and it belongs in an audit export, not on a page a customer reads before buying
 * a ticket. Publishing it made the Terms page look like a compliance console. The version is
 * still resolved and still recorded against every consent - it simply is not consumer copy.
 *
 * -- WHY A DISCLOSURE AND NOT FOUR PILLS -------------------------------------------------
 * A row of equal-weight country buttons presents jurisdiction as the first decision a reader
 * has to make, which is backwards: almost nobody needs to change it, and the document is the
 * point. It also made "all other countries" look like a fourth market we operate in rather
 * than the fallback it is. A `<details>` disclosure keeps the region visible, keeps changing
 * it one click away, needs no JavaScript, is keyboard-operable and screen-reader-announced by
 * construction, and stays readable when there are twelve markets instead of four.
 */
export function PolicyContext({
  type,
  country,
  path,
}: {
  type: PolicyType;
  country: PolicyJurisdiction;
  /** The canonical path of this document, e.g. `/terms`. */
  path: string;
}) {
  const policy = getApplicablePolicy(type, country);
  return (
    <div className="mx-auto max-w-3xl border-y border-border py-4">
      {/*
        No separator character between the two facts.

        A `&middot;` between them is fine on a wide screen and strands itself at the end of
        the first line the moment they wrap - which on a phone is always, and a phone is where
        this page gets opened, because the link arrives in a text message. The gap does the
        separating instead: side by side when there is room, stacked when there is not, and
        never a dangling mark either way.
      */}
      <div className="flex flex-wrap items-baseline gap-x-5 gap-y-1 text-[0.9375rem] text-text-secondary">
        <span>
          Applicable to{' '}
          <strong className="font-semibold text-text-primary">{REGION_NAME[country]}</strong>
        </span>
        <span>Last updated {readableDate(policy.effectiveDate)}</span>
      </div>

      <details className="group mt-2">
        <summary className="inline-flex cursor-pointer list-none items-center gap-1 rounded-sm text-[0.9375rem] font-medium text-action-primary hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/60 [&::-webkit-details-marker]:hidden">
          Change region
          <span aria-hidden className="transition-transform group-open:rotate-180">
            &#9662;
          </span>
        </summary>
        <ul className="mt-3 flex flex-wrap gap-2">
          {POLICY_JURISDICTIONS.map((j) => {
            const active = j === country;
            return (
              <li key={j}>
                <Link
                  href={`${path}?country=${j}`}
                  aria-current={active ? 'page' : undefined}
                  className={
                    active
                      ? 'inline-flex rounded-lg border border-action-primary bg-action-primary px-3 py-1.5 text-[0.875rem] font-semibold text-action-primary-foreground'
                      : 'inline-flex rounded-lg border border-border bg-background-surface px-3 py-1.5 text-[0.875rem] font-medium text-text-primary transition-colors hover:border-border-strong hover:bg-background-subtle focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/60'
                  }
                >
                  {REGION_SHORT[j]}
                  {active ? <span className="sr-only"> (currently shown)</span> : null}
                </Link>
              </li>
            );
          })}
        </ul>
        <p className="mt-3 text-[0.875rem] text-text-secondary">
          {type === 'REFUNDS'
            ? 'A refund follows the policy of the country the event is in, whichever version you are reading here.'
            : 'We publish a version for each country we operate in. Everywhere else reads the same terms.'}
        </p>
      </details>
    </div>
  );
}

/**
 * Who operates ETicketsGo, as a quiet footer line on a legal document.
 *
 * -- WHY THIS IS NOT PER COUNTRY ---------------------------------------------------------
 * It used to resolve an operating entity from the reader's market, so an Indian reader was
 * told their contract was with the Indian company. NOTHING IN THIS PROJECT ESTABLISHES THAT.
 * Two entities exist, and which one contracts with a buyer for a given sale is a question
 * about corporate structure and tax, not about which page somebody is reading - it was an
 * assumption dressed as a fact on a legal page.
 *
 * So this states only what is actually established: ETicketsGo is operated by DeepTrics LLC.
 * The other entity stays in the registry, unused by this component, because the answer may
 * well be per-market - counsel has to settle it. See docs/compliance/LEGAL-REVIEW-QUESTIONS.md.
 */
export function OperatorLine() {
  return (
    <p className="mx-auto max-w-3xl text-[0.875rem] text-text-secondary">
      ETicketsGo is operated by {PLATFORM_OPERATOR.legalName}. Questions about these terms:{' '}
      <a
        className="font-medium text-action-primary hover:underline"
        href="mailto:support@eticketsgo.com"
      >
        support@eticketsgo.com
      </a>
      .
    </p>
  );
}

/**
 * The country a legal page should render, taken ONLY from the URL.
 *
 * Anything unrecognised - absent, misspelt, injected - resolves to the global text rather
 * than to an error or to a guess, because a legal page that fails to render is worse than one
 * showing the text written for everybody.
 */
export function jurisdictionFromSearch(raw: string | string[] | undefined): PolicyJurisdiction {
  const value = Array.isArray(raw) ? raw[0] : raw;
  return policyJurisdictionFor(value);
}

/**
 * The shell every legal document sits in, so the five of them are one place and not five.
 *
 * Deliberately NOT the marketing `Section`. Its `py-10 sm:py-24` is the rhythm for landing
 * pages, where a section is a slide; on a document it put 96px of nothing between the title
 * and the first line, which is what made these pages read as a compliance console with an
 * essay pasted in. A document wants to start promptly and then breathe between sections.
 *
 * The background is explicit for the reason the contrast gate found earlier: the hero's
 * blurred backdrop has a bounding box that reaches past it, so text below needs a named
 * surface rather than an inherited one.
 */
export function LegalDocument({ children }: { children: React.ReactNode }) {
  return (
    <section className="bg-background-canvas pb-20 pt-8 sm:pb-28 sm:pt-10">
      <div className="mx-auto w-full max-w-shell px-4 sm:px-6 lg:px-8">
        <div className="space-y-6">{children}</div>
      </div>
    </section>
  );
}
