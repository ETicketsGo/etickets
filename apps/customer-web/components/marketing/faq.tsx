'use client';

import { useMemo, useState } from 'react';
import { Search } from 'lucide-react';
import { Link } from '@/i18n/navigation';

export interface FaqItem {
  q: string;
  a: string;
}
export interface FaqGroup {
  category: string;
  items: FaqItem[];
}

export function FaqSearch({ groups }: { groups: FaqGroup[] }) {
  const [query, setQuery] = useState('');
  const q = query.trim().toLowerCase();

  const filtered = useMemo(() => {
    if (!q) return groups;
    return groups
      .map((g) => ({
        ...g,
        items: g.items.filter(
          (i) => i.q.toLowerCase().includes(q) || i.a.toLowerCase().includes(q),
        ),
      }))
      .filter((g) => g.items.length > 0);
  }, [groups, q]);

  return (
    <div>
      <div className="relative mx-auto max-w-xl">
        <Search className="pointer-events-none absolute left-3.5 top-1/2 h-4 w-4 -translate-y-1/2 text-text-muted" />
        <input
          type="search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search questions…"
          aria-label="Search FAQs"
          className="w-full rounded-xl border border-border bg-background-surface py-2.5 pl-10 pr-3.5 text-[0.9375rem] text-text-primary shadow-xs placeholder:text-text-muted focus:border-action-primary focus:outline-none focus:ring-2 focus:ring-ring/40"
        />
      </div>

      <div className="mt-10 space-y-10">
        {filtered.length === 0 ? (
          <p className="text-center text-[0.9375rem] text-text-muted">
            No questions match “{query}”. Try a different term or{' '}
            <Link href="/contact" className="font-medium text-action-primary hover:underline">
              contact us
            </Link>
            .
          </p>
        ) : (
          filtered.map((g) => (
            <section key={g.category}>
              <h2 className="text-caption font-semibold uppercase tracking-wide text-text-muted">
                {g.category}
              </h2>
              <div className="mt-4 divide-y divide-border rounded-2xl border border-border bg-background-surface">
                {g.items.map((i) => (
                  <details
                    key={i.q}
                    className="group px-5 py-4 [&_summary::-webkit-details-marker]:hidden"
                  >
                    <summary className="flex cursor-pointer items-center justify-between gap-4 text-[0.9375rem] font-semibold text-text-primary">
                      {i.q}
                      <span
                        className="text-text-muted transition-transform group-open:rotate-45"
                        aria-hidden
                      >
                        +
                      </span>
                    </summary>
                    <p className="mt-3 text-[0.9375rem] leading-relaxed text-text-secondary">
                      {i.a}
                    </p>
                  </details>
                ))}
              </div>
            </section>
          ))
        )}
      </div>
    </div>
  );
}
