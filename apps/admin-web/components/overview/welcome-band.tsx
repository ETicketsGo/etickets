'use client';

import { useEffect, useState } from 'react';
import { CalendarDays, ShieldCheck } from 'lucide-react';
import { accountRoleLabel, useAuthUser } from '@eticketsgo/web-kit';

/** "Good morning" by the reader's own clock, once mounted: the server's clock is UTC. */
function greetingFor(hour: number): string {
  if (hour < 5) return 'Good evening';
  if (hour < 12) return 'Good morning';
  if (hour < 17) return 'Good afternoon';
  return 'Good evening';
}

const TODAY_FORMAT = new Intl.DateTimeFormat('en-GB', {
  weekday: 'long',
  day: 'numeric',
  month: 'long',
  year: 'numeric',
});

/**
 * The top of the command center: the reference's welcome band, made of facts and not stock
 * art - who is signed in, with which role, and today's date in their own zone.
 *
 * The page's h1 stays "Platform overview": it is what the page is, and what the menu, a
 * screen reader's heading list and the tests call it. The greeting is the line above it.
 */
export function WelcomeBand() {
  const { user } = useAuthUser();
  const [now, setNow] = useState<Date | null>(null);
  useEffect(() => setNow(new Date()), []);

  const first = user?.fullName?.trim().split(/\s+/)[0];
  const role = accountRoleLabel(user?.roles);
  const greeting = now ? greetingFor(now.getHours()) : 'Welcome back';

  return (
    <section
      aria-labelledby="overview-title"
      className="relative overflow-hidden rounded-xl border border-border bg-gradient-to-br from-tile-teal via-background-surface to-tile-blue px-5 py-6 shadow-xs sm:px-7 sm:py-7"
    >
      {/* Decoration only: soft rings in the console's own tints, behind the words. */}
      <span
        aria-hidden
        className="pointer-events-none absolute -right-10 -top-16 h-56 w-56 rounded-full border-[28px] border-tile-teal opacity-70"
      />
      <span
        aria-hidden
        className="pointer-events-none absolute -bottom-20 right-24 hidden h-44 w-44 rounded-full border-[20px] border-tile-blue opacity-80 sm:block"
      />
      <div className="relative flex flex-wrap items-end justify-between gap-x-6 gap-y-4">
        <div className="min-w-0">
          <p className="text-micro font-semibold uppercase tracking-[0.08em] text-action-primary">
            {greeting}
            {first ? `, ${first}` : ''}
          </p>
          <h1
            id="overview-title"
            className="mt-1.5 font-display text-display font-bold tracking-tight text-text-primary"
          >
            Platform overview
          </h1>
          <p className="mt-1 text-ui text-text-secondary">
            What needs you, and how the marketplace is doing.
          </p>
        </div>
        <ul className="flex flex-wrap gap-2 text-caption">
          {now && (
            <li className="inline-flex items-center gap-1.5 rounded-full border border-border bg-background-surface px-3 py-1 font-medium text-text-primary">
              <CalendarDays className="h-3.5 w-3.5 text-text-secondary" aria-hidden />
              {TODAY_FORMAT.format(now)}
            </li>
          )}
          {role && (
            <li className="inline-flex items-center gap-1.5 rounded-full border border-border bg-background-surface px-3 py-1 font-medium text-text-primary">
              <ShieldCheck className="h-3.5 w-3.5 text-text-secondary" aria-hidden />
              {role}
            </li>
          )}
        </ul>
      </div>
    </section>
  );
}
