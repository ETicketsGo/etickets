'use client';

import { useQuery } from '@tanstack/react-query';
import { Search } from 'lucide-react';
import { useEffect, useState } from 'react';
import { api } from '@/lib/api';
import { EventCard } from '@/components/event-card';
import { Button, EmptyState, Input } from '@/components/ui';

export default function EventsPage() {
  const [q, setQ] = useState('');
  const [city, setCity] = useState('');
  const [category, setCategory] = useState('');
  const [applied, setApplied] = useState<{ q?: string; city?: string; category?: string }>({});

  // Honour deep links from the home page (?q= / ?category= / ?city=).
  useEffect(() => {
    const p = new URLSearchParams(window.location.search);
    const initial = {
      q: p.get('q') ?? '',
      city: p.get('city') ?? '',
      category: p.get('category') ?? '',
    };
    setQ(initial.q);
    setCity(initial.city);
    setCategory(initial.category);
    setApplied({
      q: initial.q || undefined,
      city: initial.city || undefined,
      category: initial.category || undefined,
    });
  }, []);

  const { data, isLoading } = useQuery({
    queryKey: ['events', applied],
    queryFn: () => api.listEvents({ pageSize: '24', ...applied }),
  });

  return (
    <div className="space-y-8">
      <div>
        <h1 className="text-h2 font-bold tracking-tight text-text-primary">Browse events</h1>
        <p className="mt-1.5 text-[0.9375rem] text-text-muted">
          Search by title, city, or category.
        </p>
      </div>

      <form
        className="grid gap-3 rounded-lg border border-border bg-background-surface p-4 shadow-sm sm:grid-cols-[1fr_1fr_1fr_auto]"
        onSubmit={(e) => {
          e.preventDefault();
          setApplied({
            q: q || undefined,
            city: city || undefined,
            category: category || undefined,
          });
        }}
      >
        <Input
          id="q"
          label="Search"
          icon={Search}
          placeholder="Title…"
          value={q}
          onChange={(e) => setQ(e.target.value)}
        />
        <Input
          id="city"
          label="City"
          placeholder="Bengaluru"
          value={city}
          onChange={(e) => setCity(e.target.value)}
        />
        <Input
          id="category"
          label="Category"
          placeholder="Music"
          value={category}
          onChange={(e) => setCategory(e.target.value)}
        />
        <div className="flex items-end">
          <Button type="submit" className="w-full">
            Search
          </Button>
        </div>
      </form>

      {isLoading ? (
        <div className="grid gap-6 sm:grid-cols-2 lg:grid-cols-3">
          {Array.from({ length: 6 }).map((_, i) => (
            <div
              key={i}
              className="h-72 animate-pulse rounded-lg border border-border bg-background-subtle"
            />
          ))}
        </div>
      ) : data && data.data.length > 0 ? (
        <>
          <p className="text-caption text-text-muted">{data.meta.total} event(s)</p>
          <div className="grid gap-6 sm:grid-cols-2 lg:grid-cols-3">
            {data.data.map((e) => (
              <EventCard key={e.id} event={e} />
            ))}
          </div>
        </>
      ) : (
        <EmptyState
          title="No events match your search"
          hint="Try clearing filters."
          icon={Search}
        />
      )}
    </div>
  );
}
