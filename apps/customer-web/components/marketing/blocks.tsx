import { Container, Eyebrow, GradientBackdrop, PrimaryLink, SecondaryLink } from './kit';

/** Interior-page hero: eyebrow, title, lead, optional CTAs, on a soft backdrop. */
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
    <div className="relative overflow-hidden border-b border-border">
      <GradientBackdrop />
      <Container className="py-16 text-center sm:py-24">
        <div className="mx-auto max-w-3xl">
          <div className="flex justify-center">
            <Eyebrow>{eyebrow}</Eyebrow>
          </div>
          <h1 className="mt-5 text-balance text-4xl font-bold leading-[1.1] tracking-tight text-text-primary sm:text-5xl">
            {title}
          </h1>
          <p className="mx-auto mt-5 max-w-2xl text-pretty text-lg leading-relaxed text-text-secondary">
            {lead}
          </p>
          {(primary || secondary) && (
            <div className="mt-8 flex flex-col items-center justify-center gap-3 sm:flex-row">
              {primary && <PrimaryLink href={primary.href}>{primary.label}</PrimaryLink>}
              {secondary && <SecondaryLink href={secondary.href}>{secondary.label}</SecondaryLink>}
            </div>
          )}
        </div>
      </Container>
    </div>
  );
}

/** A dismissible-looking notice banner (static) for placeholder/legal-review notes. */
export function NoticeBanner({ children }: { children: React.ReactNode }) {
  return (
    <div className="rounded-2xl border border-status-warning/30 bg-status-warning/5 px-5 py-4 text-[0.9375rem] text-text-secondary">
      <span className="font-semibold text-status-warning">Please note:</span> {children}
    </div>
  );
}

/**
 * Long-form content wrapper with tasteful typographic defaults for legal/docs pages
 * (Tailwind Typography is not a dependency, so styles are applied explicitly).
 */
export function Prose({ children }: { children: React.ReactNode }) {
  return (
    <div className="mx-auto max-w-3xl space-y-5 text-[0.975rem] leading-relaxed text-text-secondary [&_a]:font-medium [&_a]:text-action-primary hover:[&_a]:underline [&_h2]:mt-10 [&_h2]:text-xl [&_h2]:font-bold [&_h2]:tracking-tight [&_h2]:text-text-primary [&_h3]:mt-6 [&_h3]:text-base [&_h3]:font-semibold [&_h3]:text-text-primary [&_li]:ml-1 [&_strong]:text-text-primary [&_ul]:list-disc [&_ul]:space-y-1.5 [&_ul]:pl-5">
      {children}
    </div>
  );
}
