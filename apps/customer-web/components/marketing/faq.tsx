'use client';

import { useMemo, useState } from 'react';
import { Search } from 'lucide-react';
import { Link } from '@/i18n/navigation';
import { MK_EYEBROW, MK_FIELD, MK_LINK, MK_PANEL } from './kit';

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
        <Search
          aria-hidden
          className="pointer-events-none absolute left-3.5 top-1/2 h-4 w-4 -translate-y-1/2 text-brand-ink-3"
        />
        <input
          type="search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search questions..."
          aria-label="Search FAQs"
          className={`${MK_FIELD} h-11 pl-10`}
        />
      </div>

      <div className="mt-10 space-y-10">
        {filtered.length === 0 ? (
          <p className="text-center text-brand-ui text-brand-ink-2">
            No questions match &quot;{query}&quot;. Try a different term or{' '}
            <Link href="/contact" className={MK_LINK}>
              contact us
            </Link>
            .
          </p>
        ) : (
          filtered.map((g) => (
            <section key={g.category}>
              <h2 className={MK_EYEBROW}>{g.category}</h2>
              <div className={`mt-4 divide-y divide-brand-line ${MK_PANEL}`}>
                {g.items.map((i) => (
                  <details
                    key={i.q}
                    className="group px-5 py-4 [&_summary::-webkit-details-marker]:hidden"
                  >
                    <summary className="flex min-h-11 cursor-pointer items-center justify-between gap-4 rounded-sm text-brand-ui font-semibold text-brand-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-focus focus-visible:ring-offset-2 focus-visible:ring-offset-brand-surface">
                      {i.q}
                      <span
                        className="text-brand-ink-3 transition-transform group-open:rotate-45"
                        aria-hidden
                      >
                        +
                      </span>
                    </summary>
                    <p className="mt-3 text-brand-ui text-brand-ink-2">{i.a}</p>
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
