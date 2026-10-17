import { Link } from '@/i18n/navigation';
import {
  getApplicablePolicy,
  policyJurisdictionFor,
  type PolicyJurisdiction,
  type PolicyType,
} from '@eticketsgo/shared-types';
import { BUSINESS_DETAILS, publishedDetail } from '@eticketsgo/web-kit';
import { LEGAL_INFORMATION_HREF, operatorSentences } from '@/lib/legal-entity';

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
 * The one line of metadata a legal document shows: when it last changed.
 *
 * -- WHAT IS NOT HERE, AND WHY -----------------------------------------------------------
 * No market name, no "change region", no country pills, no explanation that we publish a
 * version per country. Two earlier attempts put those on every document and both were
 * backwards: the reader was asked to operate the policy resolver before reading the
 * document, and the fallback jurisdiction appeared as though it were a market we trade in.
 *
 * Which version applies is decided by the market the PRODUCT already resolved - see
 * `lib/market.ts`. The page simply renders the right document. The registry identifier
 * (`TERMS/IN/v1`) is still resolved and still stored on every consent record; it is an audit
 * key, not consumer copy.
 */
export function PolicyUpdated({
  type,
  country,
}: {
  type: PolicyType;
  country: PolicyJurisdiction;
}) {
  const policy = getApplicablePolicy(type, country);
  return (
    <p className="text-[0.9375rem] text-text-secondary">
      Last updated {readableDate(policy.effectiveDate)}
    </p>
  );
}

/** A quiet way back to the Legal Center, so a document is never a dead end. */
export function BackToLegal() {
  return (
    <Link
      href="/legal"
      className="inline-flex items-center gap-1.5 rounded-sm text-[0.9375rem] font-medium text-action-primary hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/60"
    >
      <span aria-hidden>&larr;</span> Legal &amp; Policies
    </Link>
  );
}

/**
 * Who operates ETicketsGo, as a quiet footer line on a legal document.
 *
 * -- WHAT IT SAYS, AND WHAT IT DOES NOT ----------------------------------------------------
 * The owner has stated who operates the platform in India: "ETicketsGo is operated in India
 * by DeepTrics Software Solutions Private Limited". That is a fact about the company, so every
 * document carries it - an India reader gets it alone, everybody else gets it beside the
 * brand's own entity, which is what this line said before. See `operatorSentences`.
 *
 * What it still does NOT say is "your contract is with". An earlier version resolved a
 * contracting entity from the reader's market, and nothing in this project establishes that;
 * which entity is the counterparty to a sale is still open with counsel
 * (docs/compliance/LEGAL-REVIEW-QUESTIONS.md).
 */
export function OperatorLine({ country }: { country?: PolicyJurisdiction | null }) {
  const support = publishedDetail(BUSINESS_DETAILS.supportEmail);
  return (
    <p
      data-testid="operator-line"
      className="border-t border-border pt-6 text-[0.875rem] text-text-secondary"
    >
      {operatorSentences(country).join(' ')}{' '}
      <Link
        className="font-medium text-action-primary hover:underline"
        href={LEGAL_INFORMATION_HREF}
      >
        Company information
      </Link>
      .
      {support && (
        <>
          {' '}
          Questions about this document:{' '}
          <a className="font-medium text-action-primary hover:underline" href={`mailto:${support}`}>
            {support}
          </a>
          .
        </>
      )}
    </p>
  );
}

/**
 * The shell every legal document sits in, so the five of them are one place and not five.
 *
 * Deliberately NOT the marketing `Section`. Its `py-10 sm:py-24` is the rhythm for landing
 * pages, where a section is a slide; on a document it put 96px of nothing between the title
 * and the first line. A document wants to start promptly and then breathe between sections.
 *
 * `max-w-[46rem]` is a reading measure, narrower than the marketing `max-w-3xl`: these pages
 * are long prose, and prose that runs the full width of a laptop is tiring to read.
 *
 * The background is explicit for the reason the contrast gate found earlier: the hero's
 * blurred backdrop has a bounding box that reaches past it, so text below needs a named
 * surface rather than an inherited one.
 */
export function LegalDocument({ children }: { children: React.ReactNode }) {
  return (
    <section className="bg-background-canvas pb-20 pt-8 sm:pb-28 sm:pt-10">
      <div className="mx-auto w-full max-w-shell px-4 sm:px-6 lg:px-8">
        <div className="mx-auto max-w-[46rem] space-y-6">{children}</div>
      </div>
    </section>
  );
}

/** Normalise an explicit `?country=` value. Kept for the Legal Center's market links. */
export function jurisdictionFromSearch(raw: string | string[] | undefined): PolicyJurisdiction {
  const value = Array.isArray(raw) ? raw[0] : raw;
  return policyJurisdictionFor(value);
}
