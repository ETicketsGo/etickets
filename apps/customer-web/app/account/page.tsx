'use client';

import { useEffect } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { Heart, Receipt, Ticket, UserRound, Users, ChevronRight } from 'lucide-react';
import { tokenStore } from '@/lib/api';

const LINKS = [
  {
    href: '/account/bookings',
    label: 'My bookings',
    hint: 'Order history & refunds',
    icon: Receipt,
  },
  { href: '/account/tickets', label: 'My tickets', hint: 'Your QR passes', icon: Ticket },
  { href: '/account/saved', label: 'Saved events', hint: 'Your wishlist', icon: Heart },
  { href: '/account/following', label: 'Following', hint: 'Organizers you follow', icon: Users },
  { href: '/account/profile', label: 'Profile', hint: 'Name & account details', icon: UserRound },
];

export default function AccountPage() {
  const router = useRouter();
  useEffect(() => {
    if (!tokenStore.access) router.push('/login?next=/account');
  }, [router]);

  return (
    <div className="mx-auto max-w-2xl space-y-8">
      <div>
        <h1 className="text-h2 font-bold tracking-tight text-text-primary">Account</h1>
        <p className="mt-1.5 text-[0.9375rem] text-text-muted">
          Manage your bookings, tickets, and details.
        </p>
      </div>
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {LINKS.map((l) => {
          const Icon = l.icon;
          return (
            <Link
              key={l.href}
              href={l.href}
              className="group rounded-lg border border-border bg-background-surface p-5 shadow-sm transition-all hover:-translate-y-0.5 hover:shadow-md"
            >
              <div className="flex items-center justify-between">
                <span className="flex h-10 w-10 items-center justify-center rounded-full bg-action-primary/10 text-action-primary">
                  <Icon className="h-5 w-5" />
                </span>
                <ChevronRight className="h-4 w-4 text-text-muted transition-transform group-hover:translate-x-0.5" />
              </div>
              <p className="mt-4 font-semibold text-text-primary">{l.label}</p>
              <p className="mt-0.5 text-caption text-text-muted">{l.hint}</p>
            </Link>
          );
        })}
      </div>
    </div>
  );
}
