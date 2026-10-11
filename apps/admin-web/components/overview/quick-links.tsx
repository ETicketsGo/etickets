'use client';

import Link from 'next/link';
import {
  ArrowRight,
  Building2,
  CalendarDays,
  ClipboardCheck,
  Gauge,
  Landmark,
  RotateCcw,
  Scale,
  Ticket,
  type LucideIcon,
} from 'lucide-react';
import { SectionCard, tileClasses, type TileTone } from '@eticketsgo/web-kit';

interface QuickLink {
  label: string;
  href: string;
  icon: LucideIcon;
  tone: TileTone;
  /** The capability the page's data needs - the same one `lib/admin-nav.ts` names. */
  needs: string;
}

/**
 * The reference's "Quick actions", for an operator: the places a shift is actually spent.
 *
 * Every link names the capability its page needs and is offered only to somebody who holds it,
 * as the menu does - a shortcut to a page that refuses you is a dead end on the landing page.
 * These are ways IN, not queues: no counts here, so nothing on the page is counted twice.
 */
const LINKS: QuickLink[] = [
  {
    label: 'Review events',
    href: '/admin/events?status=UNDER_REVIEW',
    icon: ClipboardCheck,
    tone: 'teal',
    needs: 'EVENT_REVIEW',
  },
  {
    label: 'Verify organizers',
    href: '/admin/organizers?status=PENDING',
    icon: Building2,
    tone: 'blue',
    needs: 'ORGANIZER_REVIEW',
  },
  {
    label: 'Calendar',
    href: '/admin/calendar',
    icon: CalendarDays,
    tone: 'purple',
    needs: 'EVENT_REVIEW',
  },
  { label: 'Bookings', href: '/admin/bookings', icon: Ticket, tone: 'blue', needs: 'BOOKING_READ' },
  {
    label: 'Refunds',
    href: '/admin/refunds',
    icon: RotateCcw,
    tone: 'amber',
    needs: 'REFUND_REVIEW',
  },
  {
    label: 'Payouts',
    href: '/admin/payouts',
    icon: Landmark,
    tone: 'teal',
    needs: 'PAYOUT_MANAGE',
  },
  {
    label: 'Reconciliation',
    href: '/admin/finance-reconciliation',
    icon: Scale,
    tone: 'purple',
    needs: 'FINANCE_READ',
  },
  { label: 'Operations', href: '/admin/ops', icon: Gauge, tone: 'rose', needs: 'OPS_READ' },
];

export function QuickLinks({ capabilities }: { capabilities: ReadonlySet<string> }) {
  const links = LINKS.filter((l) => capabilities.has(l.needs));
  if (links.length === 0) return null;
  return (
    <SectionCard title="Go to">
      {/* Two across a phone held sideways; one in the tablet's half column and the side column. */}
      <ul className="grid gap-2 sm:grid-cols-2 md:grid-cols-1">
        {links.map((l) => (
          <li key={l.href}>
            <Link
              href={l.href}
              className={`group flex items-center gap-3 rounded-md border border-transparent px-3 py-2.5 text-ui font-semibold transition-[filter,box-shadow] duration-150 hover:shadow-xs hover:brightness-[0.98] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring ${tileClasses(l.tone)}`}
            >
              <l.icon className="h-4 w-4 shrink-0" aria-hidden />
              <span className="min-w-0 flex-1 truncate">{l.label}</span>
              <ArrowRight
                className="h-4 w-4 shrink-0 transition-transform duration-150 group-hover:translate-x-0.5 motion-reduce:transition-none"
                aria-hidden
              />
            </Link>
          </li>
        ))}
      </ul>
    </SectionCard>
  );
}
