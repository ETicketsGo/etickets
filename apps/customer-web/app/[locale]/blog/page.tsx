import { localizedMetadata } from '@/lib/seo';
import { Clock, ArrowRight } from 'lucide-react';
import { Container, Section } from '@/components/marketing/kit';
import { PageHero, NoticeBanner } from '@/components/marketing/blocks';
import { POSTS, CATEGORIES, formatDate } from '@/lib/blog';
import { Link } from '@/i18n/navigation';
import { BrandPage } from '@/components/storefront-brand';

export const generateMetadata = localizedMetadata('/blog', {
  title: 'Blog',
  description: 'Guides, growth ideas, and perspectives on running better events with ETicketsGo.',
});

export default function BlogPage() {
  const featured = POSTS.find((p) => p.featured) ?? POSTS[0];
  const rest = POSTS.filter((p) => p.slug !== featured.slug);

  return (
    <BrandPage>
      <PageHero
        eyebrow="Blog"
        title="Ideas for running better events"
        lead="Practical guides, growth tips, and perspectives from the ETicketsGo team."
      />
      <Section>
        <Container>
          <div className="mx-auto max-w-5xl">
            <NoticeBanner>
              All articles below are <strong>sample content</strong> for this demo build.
            </NoticeBanner>
          </div>

          {/* Categories */}
          <div className="mx-auto mt-8 flex max-w-5xl flex-wrap gap-2">
            {CATEGORIES.map((c) => (
              <span
                key={c}
                className="rounded-full border border-brand-line bg-brand-surface px-3 py-1 text-brand-meta font-medium text-brand-ink-2"
              >
                {c}
              </span>
            ))}
          </div>

          {/* Featured */}
          <Link
            href={`/blog/${featured.slug}`}
            className="mx-auto mt-8 block max-w-5xl overflow-hidden rounded-brand-card border border-brand-line bg-brand-surface transition-all hover:border-brand-ink-3"
          >
            <div className="grid gap-6 p-7 sm:grid-cols-2 sm:items-center sm:p-9">
              <div>
                <span className="inline-flex items-center rounded-full bg-brand-sunken px-3 py-1 text-brand-meta font-semibold text-brand-ink">
                  Featured - {featured.category}
                </span>
                <h2 className="mt-4 font-brand-display text-brand-d3 text-brand-ink">
                  {featured.title}
                </h2>
                <p className="mt-3 text-brand-ui leading-relaxed text-brand-ink-2">
                  {featured.excerpt}
                </p>
                <div className="mt-5 flex items-center gap-3 text-brand-meta text-brand-ink-3">
                  <span>{formatDate(featured.date)}</span>
                  <span className="inline-flex items-center gap-1">
                    <Clock className="h-3.5 w-3.5" /> {featured.readingMinutes} min
                  </span>
                </div>
              </div>
              <div
                className="hidden aspect-[4/3] items-center justify-center rounded-brand-card bg-brand-canvas sm:flex"
                data-brand-tone="stage"
              >
                <span className="font-brand-display text-brand-hero text-brand-ink">ETG</span>
              </div>
            </div>
          </Link>

          {/* Grid */}
          <div className="mx-auto mt-8 grid max-w-5xl gap-6 sm:grid-cols-2 lg:grid-cols-3">
            {rest.map((p) => (
              <Link
                key={p.slug}
                href={`/blog/${p.slug}`}
                className="group flex flex-col rounded-brand-card border border-brand-line bg-brand-surface p-6 transition-colors hover:border-brand-ink-3"
              >
                <span className="text-brand-meta font-semibold text-brand-ink">{p.category}</span>
                <h3 className="mt-2 font-brand-display text-brand-card text-brand-ink">
                  {p.title}
                </h3>
                <p className="mt-2 flex-1 text-brand-ui leading-relaxed text-brand-ink-2">
                  {p.excerpt}
                </p>
                <div className="mt-4 flex items-center justify-between text-brand-meta text-brand-ink-3">
                  <span className="inline-flex items-center gap-1">
                    <Clock className="h-3.5 w-3.5" /> {p.readingMinutes} min
                  </span>
                  <span className="inline-flex items-center gap-1 font-semibold text-brand-ink">
                    Read{' '}
                    <ArrowRight className="h-3.5 w-3.5 transition-transform group-hover:translate-x-0.5" />
                  </span>
                </div>
              </Link>
            ))}
          </div>
        </Container>
      </Section>
    </BrandPage>
  );
}
