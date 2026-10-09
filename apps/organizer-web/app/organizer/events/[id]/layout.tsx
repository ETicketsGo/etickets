'use client';

import { useEffect, useId, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import Link from 'next/link';
import { useParams, usePathname } from 'next/navigation';
import { ChevronDown } from 'lucide-react';
import { api, StatusBadge, Skeleton, ErrorState } from '@eticketsgo/web-kit';
import { useOrg } from '@/components/org-context';
import {
  resolveEventLocation,
  segmentOf,
  visibleSections,
  type EventSection,
} from '@/lib/event-sections';

/*
  The event's navigation is data in `lib/event-sections.ts` - seven sections and the pages under
  each - so the mapping can be tested without rendering. This file only draws it.

  ── WHY NOTHING HERE SCROLLS SIDEWAYS ──────────────────────────────────────────────
  The old row was `overflow-x-auto` and wider than the screen at every width, so the sections
  at its end were simply not there unless you knew to scroll a strip that did not look
  scrollable. Every list below WRAPS instead: at worst a narrow window gets a second line,
  which is visible, rather than a hidden tail, which is not.
*/

const focusRing =
  'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:ring-offset-1';

function sectionHref(base: string, section: EventSection): string {
  return `${base}${section.pages[0].seg}`;
}

/**
 * The seven sections.
 *
 * A tab bar from `md` up, where all seven fit on one line - measured, not assumed: at 768 and
 * 1024 the content column is 720-736px and the bar at full size needs about 790, so it runs a
 * step smaller until `xl`. It still wraps rather than scrolls if a font or zoom makes it wider.
 *
 * Below `md` a disclosure naming the section you are in: seven links wrapped into three ragged
 * rows at 320px read as a tag cloud, and the question on a phone is "where am I, and where else
 * can I go" - a button that answers the first and opens on the second.
 */
function SectionNav({
  base,
  sections,
  activeKey,
  currentHref,
}: {
  base: string;
  sections: EventSection[];
  activeKey: string | null;
  currentHref: string;
}) {
  const [open, setOpen] = useState(false);
  const listId = useId();
  const buttonRef = useRef<HTMLButtonElement>(null);
  const active = sections.find((s) => s.key === activeKey);

  // A navigation closes the disclosure: the new page is the answer to why it was opened.
  useEffect(() => setOpen(false), [currentHref]);

  /*
    `aria-current` is "page" when the link IS this page, and "true" when it is the section this
    page sits in - a section link points at the section's first page, so on its second page
    "page" would be a false statement to a screen reader.
  */
  const currentFor = (section: EventSection) =>
    section.key !== activeKey
      ? undefined
      : sectionHref(base, section) === currentHref
        ? ('page' as const)
        : ('true' as const);

  return (
    <nav aria-label="Event sections" data-testid="event-nav">
      <div className="md:hidden">
        <button
          ref={buttonRef}
          type="button"
          aria-expanded={open}
          aria-controls={listId}
          onClick={() => setOpen((o) => !o)}
          onKeyDown={(e) => {
            if (e.key === 'Escape') setOpen(false);
          }}
          className={`flex min-h-[2.75rem] w-full items-center justify-between gap-3 rounded-md border border-border bg-background-surface px-3 py-2 text-left text-sm ${focusRing}`}
        >
          <span className="min-w-0">
            <span className="block text-caption text-text-muted">Section</span>
            <span className="block truncate font-medium text-text-primary">
              {active?.label ?? 'Choose a section'}
            </span>
          </span>
          <ChevronDown
            aria-hidden
            className={`h-4 w-4 shrink-0 text-text-muted transition-transform ${open ? 'rotate-180' : ''}`}
          />
        </button>
        {open ? (
          <ul
            id={listId}
            className="mt-1 overflow-hidden rounded-md border border-border bg-background-surface"
            onKeyDown={(e) => {
              if (e.key === 'Escape') {
                setOpen(false);
                buttonRef.current?.focus();
              }
            }}
          >
            {sections.map((section) => {
              const current = currentFor(section);
              return (
                <li key={section.key} className="border-b border-border last:border-b-0">
                  <Link
                    href={sectionHref(base, section)}
                    aria-current={current}
                    onClick={() => setOpen(false)}
                    className={`flex min-h-[2.75rem] items-center px-3 py-2 text-sm ${focusRing} ${
                      current
                        ? 'bg-tint-primary font-semibold text-action-primary'
                        : 'text-text-secondary hover:bg-background-subtle hover:text-text-primary'
                    }`}
                  >
                    {section.label}
                  </Link>
                </li>
              );
            })}
          </ul>
        ) : null}
      </div>

      <ul className="hidden flex-wrap items-end border-b border-border md:flex">
        {sections.map((section) => {
          const current = currentFor(section);
          return (
            <li key={section.key}>
              <Link
                href={sectionHref(base, section)}
                aria-current={current}
                className={`-mb-px block whitespace-nowrap rounded-t-md border-b-2 px-2.5 py-2 text-[0.8125rem] xl:px-3 xl:text-sm ${focusRing} ${
                  current
                    ? 'border-action-primary font-semibold text-action-primary'
                    : 'border-transparent text-text-secondary hover:border-border hover:text-text-primary'
                }`}
              >
                {section.label}
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}

/**
 * The pages inside the current section - drawn only when there is more than one, because a
 * single-item menu is a label pretending to be a choice.
 */
function PageNav({
  base,
  section,
  currentHref,
}: {
  base: string;
  section: EventSection;
  currentHref: string;
}) {
  if (section.pages.length < 2) return null;
  return (
    <nav aria-label={`${section.label} pages`} data-testid="event-subnav">
      <ul className="flex flex-wrap gap-2">
        {section.pages.map((page) => {
          const href = `${base}${page.seg}`;
          const current = href === currentHref;
          return (
            <li key={page.seg}>
              <Link
                href={href}
                aria-current={current ? 'page' : undefined}
                className={`inline-flex min-h-[2.25rem] items-center rounded-full border px-3 py-1 text-sm ${focusRing} ${
                  current
                    ? 'border-action-primary bg-tint-primary font-semibold text-action-primary'
                    : 'border-border text-text-secondary hover:bg-background-subtle hover:text-text-primary'
                }`}
              >
                {page.label}
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}

export default function EventLayout({ children }: { children: React.ReactNode }) {
  const { id } = useParams<{ id: string }>();
  const pathname = usePathname();
  const { activeOrg, orgSentenceName } = useOrg();
  const base = `/organizer/events/${id}`;
  const {
    data: event,
    isLoading,
    isError,
    refetch,
  } = useQuery({
    queryKey: ['event', id],
    queryFn: () => api.events.get(id),
  });

  // The offline consoles are an offline-gate feature - only offered when the org has offline
  // check-in enabled (flag off -> their endpoints 404).
  const offlineReadiness = useQuery({
    queryKey: ['offline-readiness', event?.organizationId],
    queryFn: () => api.offlineCheckin.offlineReadiness(event!.organizationId),
    enabled: !!event?.organizationId,
    retry: false,
  });
  const offlineEnabled =
    offlineReadiness.data?.checks.find((c) => c.key === 'flag')?.passed ?? false;

  const seg = segmentOf(pathname, base);
  const sections = visibleSections(offlineEnabled, seg);
  const location = resolveEventLocation(pathname, base);
  const activeSection = location
    ? (sections.find((s) => s.key === location.section.key) ?? null)
    : null;
  const currentHref = seg === null ? pathname : `${base}${seg}`;

  if (isError)
    return (
      <ErrorState message="We couldn't load this. Please try again." onRetry={() => refetch()} />
    );

  return (
    <div className="space-y-4">
      <nav aria-label="Breadcrumb" className="text-sm text-text-muted">
        <Link href="/organizer/events" className="hover:text-text-primary">
          Events
        </Link>{' '}
        / <span className="text-text-secondary">{event?.title ?? '…'}</span>
      </nav>

      {isLoading ? (
        <Skeleton className="h-8 w-64" />
      ) : (
        <div className="flex flex-wrap items-center gap-3">
          <h1 className="min-w-0 break-words text-2xl font-bold text-text-primary">
            {event?.title}
          </h1>
          {event && <StatusBadge status={event.status} />}
          {/*
            Whose event this is, when it is not the organization the switcher is on.

            An event is reachable by link as well as by browsing, so somebody can be looking at
            one organization's event while the console is set to another - and every action on
            this page would then read as belonging to the wrong one. Named only when they differ,
            using the one identity implementation, so the ordinary case stays quiet.
          */}
          {event &&
          event.organizationId !== activeOrg.id &&
          orgSentenceName(event.organizationId) ? (
            <span className="rounded-full bg-tint-warning px-3 py-1 text-caption font-medium text-status-warning">
              In {orgSentenceName(event.organizationId)}
            </span>
          ) : null}
        </div>
      )}

      <SectionNav
        base={base}
        sections={sections}
        activeKey={activeSection?.key ?? null}
        currentHref={currentHref}
      />
      {activeSection ? (
        <PageNav base={base} section={activeSection} currentHref={currentHref} />
      ) : null}

      <div>{children}</div>
    </div>
  );
}
