import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { Clock, ArrowLeft } from 'lucide-react';
import { Container, Section } from '@/components/marketing/kit';
import { NoticeBanner } from '@/components/marketing/blocks';
import { POSTS, getPost, relatedPosts, formatDate } from '@/lib/blog';

export function generateStaticParams() {
  return POSTS.map((p) => ({ slug: p.slug }));
}

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
    <Section>
      <Container className="max-w-3xl">
        <Link
          href="/blog"
          className="inline-flex items-center gap-1.5 text-caption font-medium text-text-secondary hover:text-text-primary"
        >
          <ArrowLeft className="h-4 w-4" /> All articles
        </Link>

        <div className="mt-6">
          <span className="inline-flex items-center rounded-full bg-action-primary/10 px-3 py-1 text-caption font-semibold text-action-primary">
            {post.category}
          </span>
          <h1 className="mt-4 text-balance text-3xl font-bold leading-tight tracking-tight text-text-primary sm:text-4xl">
            {post.title}
          </h1>
          <div className="mt-4 flex flex-wrap items-center gap-3 text-caption text-text-muted">
            <span className="font-medium text-text-secondary">{post.author}</span>
            <span>· {post.role}</span>
            <span>· {formatDate(post.date)}</span>
            <span className="inline-flex items-center gap-1">
              · <Clock className="h-3.5 w-3.5" /> {post.readingMinutes} min read
            </span>
          </div>
        </div>

        <div className="mt-8">
          <NoticeBanner>
            This article is <strong>sample content</strong> for demonstration.
          </NoticeBanner>
        </div>

        <article className="mt-8 space-y-5 text-[1.0125rem] leading-relaxed text-text-secondary">
          {post.body.map((b, i) => {
            if (b.type === 'h2')
              return (
                <h2 key={i} className="mt-8 text-xl font-bold tracking-tight text-text-primary">
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

        <div className="mt-10 flex flex-wrap gap-2 border-t border-border pt-6">
          {post.tags.map((t) => (
            <span
              key={t}
              className="rounded-full bg-background-subtle px-3 py-1 text-caption text-text-secondary"
            >
              #{t}
            </span>
          ))}
        </div>

        {related.length > 0 && (
          <div className="mt-12">
            <h2 className="text-caption font-semibold uppercase tracking-wide text-text-muted">
              Related posts
            </h2>
            <div className="mt-4 grid gap-4 sm:grid-cols-2">
              {related.map((p) => (
                <Link
                  key={p.slug}
                  href={`/blog/${p.slug}`}
                  className="rounded-2xl border border-border bg-background-surface p-5 shadow-sm transition-all hover:border-action-primary/30 hover:shadow-md"
                >
                  <span className="text-caption font-semibold text-action-primary">
                    {p.category}
                  </span>
                  <h3 className="mt-1.5 font-semibold text-text-primary">{p.title}</h3>
                </Link>
              ))}
            </div>
          </div>
        )}
      </Container>
    </Section>
  );
}
