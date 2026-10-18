import { Container, Eyebrow, MK_PANEL, PrimaryLink, SecondaryLink } from './kit';

/**
 * Interior-page hero: eyebrow, title, lead, optional CTAs, on paper.
 *
 * Drawn like the top of Explore: the eyebrow, the title in the display face and one lead
 * paragraph, left-aligned on the same gutters as the header. The old hero centred the words
 * on a blue gradient wash, and its lead had to be special-cased to full-strength ink because
 * the secondary colour failed AA on that wash (4.49:1). On paper the secondary ink passes on
 * its own, so the special case went with the wash.
 */
export function PageHero({
  eyebrow,
  title,
  lead,
  primary,
  secondary,
}: {
  eyebrow: string;
  title: string;
  lead: string;
  primary?: { href: string; label: string };
  secondary?: { href: string; label: string };
}) {
  return (
    <div className="border-b border-brand-line">
      <Container className="pb-10 pt-8 lg:pb-14 lg:pt-14">
        <div className="max-w-3xl">
          <Eyebrow>{eyebrow}</Eyebrow>
          <h1 className="mt-3 text-balance font-brand-display text-brand-d1 text-brand-ink">
            {title}
          </h1>
          <p className="mt-4 max-w-prose text-pretty text-brand-lead text-brand-ink-2">{lead}</p>
          {(primary || secondary) && (
            <div className="mt-8 flex flex-col gap-3 sm:flex-row">
              {primary && <PrimaryLink href={primary.href}>{primary.label}</PrimaryLink>}
              {secondary && <SecondaryLink href={secondary.href}>{secondary.label}</SecondaryLink>}
            </div>
          )}
        </div>
      </Container>
    </div>
  );
}

/** A static notice banner for placeholder/legal-review notes. */
export function NoticeBanner({ children }: { children: React.ReactNode }) {
  return (
    <div className="rounded-brand-card bg-brand-caution-tint px-5 py-4 text-brand-ui text-brand-ink">
      <span className="font-semibold text-brand-caution">Please note:</span> {children}
    </div>
  );
}

/**
 * A white panel with a hairline, optionally headed by a title and a small action: the brand
 * layer's stand-in for the old kit `Card` (grey border, drop shadow, old title style).
 */
export function Panel({
  children,
  className = '',
  title,
  action,
}: {
  children: React.ReactNode;
  className?: string;
  title?: React.ReactNode;
  action?: React.ReactNode;
}) {
  return (
    <div className={`${MK_PANEL} p-5 sm:p-6 ${className}`}>
      {(title || action) && (
        <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
          {title && <h2 className="font-brand-display text-brand-d3 text-brand-ink">{title}</h2>}
          {action}
        </div>
      )}
      {children}
    </div>
  );
}

/**
 * Long-form content wrapper with tasteful typographic defaults for legal/docs pages
 * (Tailwind Typography is not a dependency, so styles are applied explicitly).
 *
 * Links are ink with an underline rather than a colour, so a link in a paragraph of the terms
 * is still a link in greyscale and to somebody who cannot tell blue from black.
 */
export function Prose({ children }: { children: React.ReactNode }) {
  return (
    <div className="mx-auto max-w-3xl space-y-5 text-brand-body text-brand-ink-2 [&_a]:rounded-sm [&_a]:font-medium [&_a]:text-brand-ink [&_a]:underline [&_a]:decoration-brand-line-strong [&_a]:underline-offset-4 hover:[&_a]:decoration-brand-ink [&_h2]:mt-10 [&_h2]:font-brand-display [&_h2]:text-brand-d3 [&_h2]:text-brand-ink [&_h3]:mt-6 [&_h3]:font-brand-display [&_h3]:text-brand-card [&_h3]:text-brand-ink [&_li]:ml-1 [&_strong]:text-brand-ink [&_ul]:list-disc [&_ul]:space-y-1.5 [&_ul]:pl-5">
      {children}
    </div>
  );
}
