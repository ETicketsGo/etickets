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
      className="divide-y divide-brand-line rounded-brand-card border border-brand-line bg-brand-surface"
    >
      {facts.map((fact) => (
        <div
          key={fact.key}
          data-fact={fact.key}
          className="grid gap-1 px-5 py-4 sm:grid-cols-[12rem_1fr] sm:gap-6"
        >
          <dt className="text-[0.875rem] font-semibold text-brand-ink">{fact.label}</dt>
          <dd className="text-brand-ui leading-relaxed text-brand-ink-2">
            {fact.href ? (
              <a
                className="font-medium text-brand-ink underline decoration-brand-line-strong underline-offset-4 hover:text-brand-gold-text hover:decoration-brand-gold-text"
                href={fact.href}
              >
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
