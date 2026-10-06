import { Link } from '@/i18n/navigation';
import {
  POLICY_JURISDICTIONS,
  getApplicablePolicy,
  legalEntityFor,
  policyJurisdictionFor,
  policyVersionLabel,
  type PolicyJurisdiction,
  type PolicyType,
} from '@eticketsgo/shared-types';

const LABELS: Record<PolicyJurisdiction, string> = {
  US: 'United States',
  IN: 'India',
  CA: 'Canada',
  GLOBAL: 'Other countries',
};

/**
 * Which country's version of a document the reader is looking at, and how to change it.
 *
 * -- WHY THIS IS LINKS AND NOT A SELECT --------------------------------------------------
 * Four links need no client JavaScript, so the control cannot fail to hydrate, works with
 * the keyboard by construction, is reachable by a screen reader as a list of links, and is
 * crawlable - which matters, because a messaging reviewer is told to find these pages from
 * the public site and may arrive at any one of them directly.
 *
 * -- WHY THE COUNTRY IS NEVER INFERRED ---------------------------------------------------
 * There is deliberately no IP lookup here. Showing somebody Indian terms because of where
 * their network egress happens to be, with no way to see the others, is both wrong and
 * unfixable by the reader. The country is an explicit choice in the URL, it defaults to the
 * global text, and every other version is one visible click away. Where a document applies
 * to a TRANSACTION - a refund on a specific booking - the market comes from that booking,
 * not from this control.
 */
export function PolicyJurisdictionPicker({
  type,
  country,
  path,
}: {
  type: PolicyType;
  country: PolicyJurisdiction;
  /** The canonical path of this document, e.g. `/terms`. */
  path: string;
}) {
  return (
    <nav aria-label="Choose the country this document applies to" className="mx-auto max-w-3xl">
      <p className="text-caption font-semibold uppercase tracking-wide text-text-secondary">
        Country
      </p>
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
                {LABELS[j]}
                {active ? <span className="sr-only"> (currently shown)</span> : null}
              </Link>
            </li>
          );
        })}
      </ul>
      <p className="mt-3 text-[0.875rem] text-text-secondary">
        {type === 'REFUNDS'
          ? 'A refund always follows the policy of the country the event is in, whichever version you are reading here.'
          : 'Choose a country to read the version that applies there.'}
      </p>
    </nav>
  );
}

/**
 * Who the reader is contracting with, which version they are reading, and since when.
 *
 * The version label is the same string a consent record stores, so an audit row and the page
 * a person actually read name each other without a lookup table.
 */
export function PolicyMeta({ type, country }: { type: PolicyType; country: PolicyJurisdiction }) {
  const policy = getApplicablePolicy(type, country);
  const entity = legalEntityFor(country);
  return (
    <dl className="mx-auto flex max-w-3xl flex-wrap gap-x-8 gap-y-2 border-y border-border py-4 text-[0.875rem]">
      <div>
        <dt className="inline font-semibold text-text-primary">Operator: </dt>
        <dd className="inline text-text-secondary">{entity.legalName}</dd>
      </div>
      <div>
        <dt className="inline font-semibold text-text-primary">Version: </dt>
        <dd className="inline text-text-secondary">
          <span className="font-mono">{policyVersionLabel(policy)}</span>
        </dd>
      </div>
      <div>
        <dt className="inline font-semibold text-text-primary">Effective: </dt>
        <dd className="inline text-text-secondary">{policy.effectiveDate}</dd>
      </div>
    </dl>
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
