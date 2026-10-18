import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { Clock, ArrowLeft } from 'lucide-react';
import { Container, MK_FOCUS, Section } from '@/components/marketing/kit';
import { NoticeBanner } from '@/components/marketing/blocks';
import { POSTS, getPost, relatedPosts, formatDate } from '@/lib/blog';
import { Link } from '@/i18n/navigation';
import { BrandPage } from '@/components/storefront-brand';

export function generateStaticParams() {
  return POSTS.map((p) => ({ slug: p.slug }));
}

/*
  `params` is a Promise from Next 15 onward.

  The App Router now resolves route parameters asynchronously so a page can start rendering
  before they are known. The practical consequence is small but not optional: every server
  component that reads `params` has to await it, and the build refuses to compile if it does
  not — which is how this was found rather than guessed at.
*/
export async function generateMetadata({
  params,
}: {
  params: Promise<{ slug: string }>;
}): Promise<Metadata> {
  const { slug } = await params;
  const post = getPost(slug);
  if (!post) return { title: 'Article not found' };
  return {
    title: post.title,
    description: post.excerpt,
    alternates: { canonical: `/blog/${post.slug}` },
    openGraph: { type: 'article', title: post.title, description: post.excerpt },
  };
}

export default async function BlogPostPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const post = getPost(slug);
  if (!post) notFound();
  const related = relatedPosts(post.slug, post.category);

  return (
    <BrandPage>
      <Section>
        <Container className="max-w-3xl">
          <Link
            href="/blog"
            className={`inline-flex min-h-11 items-center gap-1.5 rounded-sm text-brand-meta font-medium text-brand-ink-2 hover:text-brand-ink ${MK_FOCUS}`}
          >
            <ArrowLeft className="h-4 w-4" /> All articles
          </Link>

          <div className="mt-6">
            <span className="inline-flex items-center rounded-full bg-brand-sunken px-3 py-1 text-brand-meta font-semibold text-brand-ink">
              {post.category}
            </span>
            <h1 className="mt-4 text-balance font-brand-display text-brand-d1 text-brand-ink">
              {post.title}
            </h1>
            <div className="mt-4 flex flex-wrap items-center gap-3 text-brand-meta text-brand-ink-3">
              <span className="font-medium text-brand-ink-2">{post.author}</span>
              <span>- {post.role}</span>
              <span>- {formatDate(post.date)}</span>
              <span className="inline-flex items-center gap-1">
                - <Clock className="h-3.5 w-3.5" /> {post.readingMinutes} min read
              </span>
            </div>
          </div>

          <div className="mt-8">
            <NoticeBanner>
              This article is <strong>sample content</strong> for demonstration.
            </NoticeBanner>
          </div>

          <article className="mt-8 space-y-5 text-brand-body text-brand-ink-2">
            {post.body.map((b, i) => {
              if (b.type === 'h2')
                return (
                  <h2 key={i} className="mt-8 font-brand-display text-brand-d3 text-brand-ink">
                    {b.text}
                  </h2>
                );
              if (b.type === 'ul')
                return (
                  <ul key={i} className="list-disc space-y-2 pl-6">
                    {b.items.map((it) => (
                      <li key={it}>{it}</li>
                    ))}
                  </ul>
                );
              return <p key={i}>{b.text}</p>;
            })}
          </article>

          <div className="mt-10 flex flex-wrap gap-2 border-t border-brand-line pt-6">
            {post.tags.map((t) => (
              <span
                key={t}
                className="rounded-full bg-brand-sunken px-3 py-1 text-brand-meta text-brand-ink-2"
              >
                #{t}
              </span>
            ))}
          </div>

          {related.length > 0 && (
            <div className="mt-12">
              <h2 className="text-brand-eyebrow uppercase text-brand-ink-3">Related posts</h2>
              <div className="mt-4 grid gap-4 sm:grid-cols-2">
                {related.map((p) => (
                  <Link
                    key={p.slug}
                    href={`/blog/${p.slug}`}
                    className={`rounded-brand-card border border-brand-line bg-brand-surface p-5 transition-colors hover:border-brand-ink-3 ${MK_FOCUS}`}
                  >
                    <span className="text-brand-meta font-semibold text-brand-ink">
                      {p.category}
                    </span>
                    <h3 className="mt-1.5 font-brand-display text-brand-card text-brand-ink">
                      {p.title}
                    </h3>
                  </Link>
                ))}
              </div>
            </div>
          )}
        </Container>
      </Section>
    </BrandPage>
  );
}
