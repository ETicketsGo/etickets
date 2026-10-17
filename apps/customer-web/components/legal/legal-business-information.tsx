import { legalBusinessFacts } from '@/lib/legal-entity';

/**
 * The "Legal and business information" block: the company behind ETicketsGo and how to
 * reach it.
 *
 * -- WHY IT LIVES ON THE ABOUT PAGE ------------------------------------------------------
 * One public address for the question "which company is this?", which is the page a carrier
 * reviewer (STPL/MSG91 DLT) and a customer both open first for it. A separate page would be
 * one more route to keep in two footers, the sitemap and the shell list; the Contact page and
 * every legal document link here instead (`/about#legal-information`).
 *
 * Every row comes from `legalBusinessFacts`, which leaves out what the owner has not supplied
 * from the company's records - registered office, CIN, GSTIN - so the block grows on its own
 * when those are filled in and never shows a stand-in until then.
 */
export function LegalBusinessInformation() {
  const facts = legalBusinessFacts();
  return (
    <dl
      data-testid="legal-business-information"
      className="divide-y divide-border rounded-2xl border border-border bg-background-surface shadow-sm"
    >
      {facts.map((fact) => (
        <div
          key={fact.key}
          data-fact={fact.key}
          className="grid gap-1 px-5 py-4 sm:grid-cols-[12rem_1fr] sm:gap-6"
        >
          <dt className="text-[0.875rem] font-semibold text-text-primary">{fact.label}</dt>
          <dd className="text-[0.9375rem] leading-relaxed text-text-secondary">
            {fact.href ? (
              <a className="font-medium text-action-primary hover:underline" href={fact.href}>
                {fact.value}
              </a>
            ) : (
              fact.value
            )}
          </dd>
        </div>
      ))}
    </dl>
  );
}
