import type { Metadata } from 'next';
import { Clock, ArrowRight } from 'lucide-react';
import { Container, Section } from '@/components/marketing/kit';
import { PageHero, NoticeBanner } from '@/components/marketing/blocks';
import { POSTS, CATEGORIES, formatDate } from '@/lib/blog';
import { Link } from '@/i18n/navigation';

export const metadata: Metadata = {
  title: 'Blog',
  description: 'Guides, growth ideas, and perspectives on running better events with ETicketsGo.',
  alternates: { canonical: '/blog' },
};

export default function BlogPage() {
  const featured = POSTS.find((p) => p.featured) ?? POSTS[0];
  const rest = POSTS.filter((p) => p.slug !== featured.slug);

  return (
    <>
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
                className="rounded-full border border-border bg-background-surface px-3 py-1 text-caption font-medium text-text-secondary"
              >
                {c}
              </span>
            ))}
          </div>

          {/* Featured */}
          <Link
            href={`/blog/${featured.slug}`}
            className="mx-auto mt-8 block max-w-5xl overflow-hidden rounded-3xl border border-border bg-background-surface shadow-sm transition-all hover:border-action-primary/30 hover:shadow-md"
          >
            <div className="grid gap-6 p-7 sm:grid-cols-2 sm:items-center sm:p-9">
              <div>
                <span className="inline-flex items-center rounded-full bg-tint-primary px-3 py-1 text-caption font-semibold text-action-primary">
                  Featured · {featured.category}
                </span>
                <h2 className="mt-4 text-2xl font-bold tracking-tight text-text-primary">
                  {featured.title}
                </h2>
                <p className="mt-3 text-[0.9375rem] leading-relaxed text-text-secondary">
                  {featured.excerpt}
                </p>
                <div className="mt-5 flex items-center gap-3 text-caption text-text-muted">
                  <span>{formatDate(featured.date)}</span>
                  <span className="inline-flex items-center gap-1">
                    <Clock className="h-3.5 w-3.5" /> {featured.readingMinutes} min
                  </span>
                </div>
              </div>
              <div className="hidden aspect-[4/3] items-center justify-center rounded-2xl bg-gradient-to-br from-action-primary/15 via-background-subtle to-status-info/10 sm:flex">
                <span className="text-5xl font-bold text-action-primary/40">ETG</span>
              </div>
            </div>
          </Link>

          {/* Grid */}
          <div className="mx-auto mt-8 grid max-w-5xl gap-6 sm:grid-cols-2 lg:grid-cols-3">
            {rest.map((p) => (
              <Link
                key={p.slug}
                href={`/blog/${p.slug}`}
                className="group flex flex-col rounded-2xl border border-border bg-background-surface p-6 shadow-sm transition-all hover:-translate-y-0.5 hover:border-action-primary/30 hover:shadow-md"
              >
                <span className="text-caption font-semibold text-action-primary">{p.category}</span>
                <h3 className="mt-2 text-base font-bold text-text-primary">{p.title}</h3>
                <p className="mt-2 flex-1 text-[0.9375rem] leading-relaxed text-text-secondary">
                  {p.excerpt}
                </p>
                <div className="mt-4 flex items-center justify-between text-caption text-text-muted">
                  <span className="inline-flex items-center gap-1">
                    <Clock className="h-3.5 w-3.5" /> {p.readingMinutes} min
                  </span>
                  <span className="inline-flex items-center gap-1 font-semibold text-action-primary">
                    Read{' '}
                    <ArrowRight className="h-3.5 w-3.5 transition-transform group-hover:translate-x-0.5" />
                  </span>
                </div>
              </Link>
            ))}
          </div>
        </Container>
      </Section>
    </>
  );
}
