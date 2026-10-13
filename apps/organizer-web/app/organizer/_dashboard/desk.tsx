'use client';

import Link from 'next/link';
import { useId, useState, type ReactNode } from 'react';
import { ArrowRight, ChevronDown, ImageOff } from 'lucide-react';
import {
  BrandStatusPill,
  EventArtwork,
  MARKETS,
  brandButtonClasses,
  eventImageSource,
  money,
  type AnalyticsOrganizerMarket,
  type BadgeTone,
  type BrandStatus,
} from '@eticketsgo/web-kit';
import type { ChosenStep, ComingUpRow, NextStep } from './desk-model';
import { isTodayAtVenue, soldShare, venueDate, venueTime, venueWhen } from './desk-model';
import type { NeedsAction, NeedsActionItem } from './overview-model';
import { lifecycleLabel, type Selling } from './status';

/*
  ── THE DESK OVERVIEW'S PIECES ──────────────────────────────────────────────────────
  Brand tokens only (docs/design/DESIGN-SYSTEM.md): paper and ink, hairlines, one shadow for
  nothing here (nothing floats), numbers in Inter tabular, the display face for the page title
  only, marigold only for "Today". Every class resolves inside the shell's data-brand="console".
*/

const RING =
  'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-focus focus-visible:ring-offset-2 focus-visible:ring-offset-brand-canvas';

const LINK = `rounded-sm font-semibold text-brand-ink underline-offset-4 hover:underline ${RING}`;

const count = (n: number) => n.toLocaleString('en-IN');

/** The console's badge tones, said in the brand's state colours. */
const TONE: Record<BadgeTone, BrandStatus> = {
  success: 'positive',
  info: 'info',
  warning: 'caution',
  error: 'critical',
  neutral: 'neutral',
};

const STATE_PILL: Record<BrandStatus, string> = {
  positive: 'bg-brand-positive-tint text-brand-positive',
  caution: 'bg-brand-caution-tint text-brand-caution',
  critical: 'bg-brand-critical-tint text-brand-critical',
  info: 'bg-brand-info-tint text-brand-info',
  neutral: 'bg-brand-sunken text-brand-ink-2',
  live: 'bg-brand-marigold text-brand-on-marigold',
};

/**
 * The sale state, in the console's one sentence ("Selling", "Partly selling: <reason>").
 *
 * `BrandStatusPill` is a fixed 24px row, which cuts a reason short; the reason is the point
 * (`sale-state-agreement.spec.ts` holds every screen to the same full sentence), so this pill
 * wraps to a second line instead. Listed for D-1 as a wrapping pill variant.
 */
function StatePill({ tone, children }: { tone: BrandStatus; children: ReactNode }) {
  return (
    <span
      className={`inline-flex min-h-6 max-w-[15rem] items-center rounded-brand-control px-2 py-0.5 text-brand-meta font-semibold ${STATE_PILL[tone]}`}
    >
      {children}
    </span>
  );
}

// ─── Header ─────────────────────────────────────────────────────────────────────

export function OverviewHeader({
  dateLine,
  welcome,
  status,
}: {
  dateLine: string;
  welcome?: string;
  status?: { label: string; tone: BrandStatus } | null;
}) {
  return (
    <header className="flex flex-col gap-1">
      <p className="text-brand-eyebrow uppercase text-brand-ink-3">{dateLine}</p>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <h1 className="font-brand-display text-brand-page text-brand-ink">Overview</h1>
        {status && <BrandStatusPill status={status.tone}>{status.label}</BrandStatusPill>}
      </div>
      {welcome && <p className="text-brand-ui text-brand-ink-2">{welcome}</p>}
    </header>
  );
}

// ─── The figures ────────────────────────────────────────────────────────────────

export interface FigureCell {
  key: string;
  label: string;
  value: string;
  context: string;
  href?: string;
  /** Said in words in `context` too; the colour only repeats it. */
  alert?: boolean;
}

/**
 * Up to four numbers, one hairline card. The number is the loudest thing on the page; one line
 * of context under it; the whole cell opens the page that explains it.
 */
export function FigureStrip({ cells }: { cells: FigureCell[] }) {
  return (
    <section aria-label="Your figures">
      <ul
        className={`grid grid-cols-2 overflow-hidden rounded-brand-card border border-brand-line bg-brand-surface ${
          cells.length >= 4 ? 'md:grid-cols-4' : cells.length === 3 ? 'md:grid-cols-3' : ''
        }`}
      >
        {cells.map((c, i) => {
          // One small definition list per figure: valid inside the link that opens its page.
          const body = (
            <dl>
              <dt className="text-brand-eyebrow uppercase text-brand-ink-3">{c.label}</dt>
              <dd className="mt-2 text-brand-figure tabular-nums text-brand-ink">{c.value}</dd>
              <dd
                className={`mt-1 text-brand-meta ${c.alert ? 'font-semibold text-brand-critical' : 'text-brand-ink-2'}`}
              >
                {c.context}
              </dd>
            </dl>
          );
          /*
            Hairlines between cells, drawn per position so a 2x2 phone grid and a 1x4 desk row
            both get exactly one line between neighbours and none on the outside edge.
          */
          const edges = [
            i % 2 === 1 ? 'border-l' : '',
            i >= 2 ? 'border-t md:border-t-0' : '',
            cells.length >= 3 && i >= 1 ? 'md:border-l' : '',
            cells.length >= 3 && i === 2 ? 'max-md:border-l-0' : '',
          ].join(' ');
          return (
            <li key={c.key} className={`min-w-0 border-brand-line ${edges}`}>
              {c.href ? (
                <Link
                  href={c.href}
                  className={`block h-full p-4 transition-colors duration-150 hover:bg-brand-sunken md:p-6 ${RING} focus-visible:ring-offset-0`}
                >
                  {body}
                </Link>
              ) : (
                <div className="h-full p-4 md:p-6">{body}</div>
              )}
            </li>
          );
        })}
      </ul>
    </section>
  );
}

// ─── Coming up ──────────────────────────────────────────────────────────────────

function Thumb({ row }: { row: ComingUpRow }) {
  const img = eventImageSource(
    { variants: row.event.imageVariants, path: row.event.imagePath },
    'thumb',
  );
  if (img) {
    return (
      <EventArtwork
        src={img.src}
        srcSet={img.srcSet}
        sizes="48px"
        alt=""
        title={row.event.title}
        ratio="1:1"
        className="!h-12 !w-12 shrink-0 self-start !rounded-brand-control"
      />
    );
  }
  /*
    No picture: a quiet sunken tile with an image-off glyph, named "No image yet" for assistive
    technology and in a tooltip. At 48px the brand's typographic artwork has no room for its
    title, and a mark that explains nothing reads as a placeholder (owner review, round 2).
  */
  return (
    <span
      role="img"
      aria-label="No image yet"
      title="No image yet"
      className="flex h-12 w-12 shrink-0 items-center justify-center rounded-brand-control border border-brand-line bg-brand-sunken text-brand-ink-3"
    >
      <ImageOff className="h-5 w-5" aria-hidden />
    </span>
  );
}

interface RowFacts {
  href: string;
  when: string;
  day: string | null;
  time: string | null;
  more: string | null;
  today: boolean;
  sold: { sold: number; capacity: number } | null;
  gross: string[] | null;
  state: { label: string; tone: BrandStatus };
}

function factsOf(row: ComingUpRow, selling: Selling | undefined, showMoney: boolean): RowFacts {
  const e = row.event;
  const more = Math.max(0, (e.schedule?.upcomingSessions ?? 0) - 1);
  const state =
    row.kind === 'not-yet'
      ? {
          label: lifecycleLabel(e.status),
          tone: (e.status === 'UNDER_REVIEW' ? 'info' : 'neutral') as BrandStatus,
        }
      : selling
        ? { label: selling.label, tone: TONE[selling.tone] }
        : // A role that may not ask the server: where the event is in its life, never a guess.
          { label: lifecycleLabel(e.status), tone: 'neutral' as BrandStatus };
  return {
    href: `/organizer/events/${e.id}`,
    when: row.startsAt ? venueWhen(row.startsAt, row.zone) : 'Not scheduled',
    day: row.startsAt ? venueDate(row.startsAt, row.zone) : null,
    time: row.startsAt ? venueTime(row.startsAt, row.zone) : null,
    more: more > 0 ? `${count(more)} more ${more === 1 ? 'date' : 'dates'}` : null,
    today: row.kind === 'on-sale' && !!row.startsAt && isTodayAtVenue(row.startsAt, row.zone),
    sold: row.kind === 'on-sale' && e.tickets ? e.tickets : null,
    gross: showMoney
      ? (e.sales ?? [])
          .filter((s) => s.grossMinor !== 0)
          .map((s) => money(s.grossMinor, s.currency))
      : null,
    state,
  };
}

function SoldBar({ sold, capacity, title }: { sold: number; capacity: number; title: string }) {
  const share = soldShare(sold, capacity);
  return (
    <div className="flex min-w-0 flex-col gap-2">
      <span
        className="whitespace-nowrap text-brand-ui tabular-nums text-brand-ink"
        aria-label={`${count(sold)} of ${count(capacity)} tickets sold for ${title}`}
      >
        {count(sold)} / {count(capacity)}
      </span>
      {/* The bar is the figure above it, drawn: decoration for assistive technology. */}
      <span aria-hidden className="h-1 w-full overflow-hidden rounded-full bg-brand-sunken">
        <span className="block h-full rounded-full bg-brand-ink" style={{ width: `${share}%` }} />
      </span>
    </div>
  );
}

/**
 * What is happening: the next events on sale with how they are selling, then what is not on
 * sale yet. A table from a tablet up; on a phone, one row per event with the two facts that
 * matter (when, and how it is selling).
 */
export function ComingUp({
  rows,
  total,
  sellingOf,
  showMoney,
  empty,
}: {
  rows: ComingUpRow[];
  total: number;
  sellingOf: (eventId: string) => Selling | undefined;
  showMoney: boolean;
  empty: ReactNode;
}) {
  const headingId = useId();
  const facts = rows.map((r) => ({ row: r, f: factsOf(r, sellingOf(r.event.id), showMoney) }));
  return (
    <section
      aria-labelledby={headingId}
      className="min-w-0 overflow-hidden rounded-brand-card border border-brand-line bg-brand-surface"
    >
      <div className="flex items-baseline justify-between gap-4 px-4 pb-3 pt-4 md:px-6">
        <h2 id={headingId} className="text-brand-body font-semibold text-brand-ink">
          Coming up
        </h2>
        {total > 0 && (
          <Link href="/organizer/events" className={`text-brand-meta ${LINK}`}>
            All events
          </Link>
        )}
      </div>

      {rows.length === 0 ? (
        <div className="border-t border-brand-line px-4 py-8 md:px-6">{empty}</div>
      ) : (
        <>
          <table className="hidden w-full table-fixed border-t border-brand-line text-left md:table">
            <caption className="sr-only">
              Your next events, how they are selling, and gross sales
            </caption>
            {/*
              Fixed layout: every column but the event is sized for its longest honest value (a date,
              a time with its zone, "1,066 / 1,660", a lakh-grouped amount, a sale sentence that
              may wrap), and the event takes what is left - its title truncates, never a number.
            */}
            <thead>
              <tr className="text-brand-eyebrow uppercase text-brand-ink-3">
                <th scope="col" className="px-6 py-3 font-semibold">
                  Event
                </th>
                <th scope="col" className="w-[8rem] px-3 py-3 font-semibold">
                  When
                </th>
                <th scope="col" className="w-[7rem] px-3 py-3 font-semibold">
                  Sold
                </th>
                {showMoney && (
                  <th scope="col" className="w-[7rem] px-3 py-3 text-right font-semibold">
                    Gross
                  </th>
                )}
                <th scope="col" className="w-[9.5rem] px-6 py-3 font-semibold">
                  Status
                </th>
              </tr>
            </thead>
            <tbody>
              {facts.map(({ row, f }) => (
                <tr key={row.event.id} className="border-t border-brand-line align-middle">
                  <td className="py-3 pl-6 pr-3">
                    <Link href={f.href} className={`group flex min-w-0 items-center gap-3 ${RING}`}>
                      <Thumb row={row} />
                      <span className="min-w-0">
                        <span className="line-clamp-2 text-brand-ui font-semibold text-brand-ink group-hover:underline">
                          {row.event.title}
                        </span>
                        <span className="block truncate text-brand-meta text-brand-ink-3">
                          {row.event.venue?.name ?? 'No venue yet'}
                          {row.event.venue?.city ? `, ${row.event.venue.city}` : ''}
                        </span>
                      </span>
                    </Link>
                  </td>
                  <td className="whitespace-nowrap px-3 py-3 text-brand-ui text-brand-ink">
                    {f.today ? (
                      <BrandStatusPill status="live">Today</BrandStatusPill>
                    ) : (
                      <span className="block">{f.day ?? 'Not scheduled'}</span>
                    )}
                    {f.time && (
                      <span className="block text-brand-meta text-brand-ink-2">{f.time}</span>
                    )}
                    {f.more && (
                      <span className="block text-brand-meta text-brand-ink-3">{f.more}</span>
                    )}
                  </td>
                  <td className="px-3 py-3">
                    {f.sold ? (
                      <SoldBar {...f.sold} title={row.event.title} />
                    ) : (
                      <span className="text-brand-meta text-brand-ink-3">Not on sale</span>
                    )}
                  </td>
                  {showMoney && (
                    <td className="whitespace-nowrap px-3 py-3 text-right text-brand-ui tabular-nums text-brand-ink">
                      {f.gross && f.gross.length > 0 ? (
                        f.gross.map((g) => (
                          <span key={g} className="block">
                            {g}
                          </span>
                        ))
                      ) : (
                        <span className="text-brand-meta text-brand-ink-3">None yet</span>
                      )}
                    </td>
                  )}
                  <td className="px-6 py-3">
                    <StatePill tone={f.state.tone}>{f.state.label}</StatePill>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>

          <ul className="border-t border-brand-line md:hidden" aria-label="Your next events">
            {facts.map(({ row, f }) => (
              <li key={row.event.id} className="border-b border-brand-line last:border-b-0">
                <Link href={f.href} className={`flex gap-3 px-4 py-4 ${RING}`}>
                  <Thumb row={row} />
                  <span className="flex min-w-0 flex-1 flex-col gap-1">
                    <span className="line-clamp-2 text-brand-ui font-semibold text-brand-ink">
                      {row.event.title}
                    </span>
                    <span className="flex flex-wrap items-center gap-2 text-brand-meta text-brand-ink-2">
                      {f.when}
                      {f.today && <BrandStatusPill status="live">Today</BrandStatusPill>}
                    </span>
                    <span className="flex flex-wrap items-center gap-x-3 gap-y-1 text-brand-meta tabular-nums text-brand-ink-2">
                      {f.sold && (
                        <span>
                          {count(f.sold.sold)} / {count(f.sold.capacity)} sold
                        </span>
                      )}
                      {f.gross && f.gross.length > 0 && <span>{f.gross.join(', ')}</span>}
                    </span>
                    <span className="mt-1">
                      <StatePill tone={f.state.tone}>{f.state.label}</StatePill>
                    </span>
                  </span>
                </Link>
              </li>
            ))}
          </ul>
          {total > rows.length && (
            <div className="border-t border-brand-line px-4 py-3 md:px-6">
              <Link href="/organizer/events" className={`text-brand-meta ${LINK}`}>
                View all {count(total)} events
              </Link>
            </div>
          )}
        </>
      )}
    </section>
  );
}

// ─── Needs you, and the next step ───────────────────────────────────────────────

const SEVERITY: Record<NeedsActionItem['severity'], { label: string; tone: BrandStatus }> = {
  blocking: { label: 'Blocking', tone: 'critical' },
  warning: { label: 'Warning', tone: 'caution' },
};

/** The next step: one sentence, one reason, one button. */
/** What a member who cannot act on an item is told instead of a "Fix this" they would be refused. */
const OWNER_DOES_IT = "Your organization's owner or a manager needs to do this.";

function StepBlock({
  step,
  eyebrow,
  blocking = false,
  readOnly = false,
}: {
  step: NextStep;
  eyebrow: string;
  blocking?: boolean;
  /** The viewer's role cannot do it: say who can, and offer no button that would refuse them. */
  readOnly?: boolean;
}) {
  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2">
        <p className="text-brand-eyebrow uppercase text-brand-ink-3">{eyebrow}</p>
        {blocking && <BrandStatusPill status="critical">Blocking</BrandStatusPill>}
      </div>
      <div className="flex flex-col gap-1">
        <p className="text-brand-body font-semibold text-brand-ink">{step.title}</p>
        {step.detail && <p className="text-brand-meta text-brand-ink-2">{step.detail}</p>}
      </div>
      {readOnly ? (
        <p className="text-brand-meta font-semibold text-brand-ink-2">{OWNER_DOES_IT}</p>
      ) : (
        <Link href={step.href} className={`self-start ${brandButtonClasses('secondary', 'md')}`}>
          {step.actionLabel}
          <ArrowRight className="h-4 w-4" aria-hidden />
        </Link>
      )}
    </div>
  );
}

/**
 * What needs the organizer, costliest first (blocking before warnings - the order
 * `needsAction` already gives), led by the page's one next step (`pickNextStep`). When the
 * step is one of the items it is drawn once, as the step.
 */
export function NeedsYou({
  needs,
  next,
  failed,
  onRetry,
  shown = 4,
  canAct = true,
}: {
  needs: NeedsAction;
  next: ChosenStep | null;
  failed: boolean;
  onRetry: () => void;
  shown?: number;
  /** False for check-in staff: the items are shown read-only, with no "Fix this". */
  canAct?: boolean;
}) {
  const headingId = useId();
  const rest = needs.items.filter((i) => i.key !== next?.itemKey);
  const listed = rest.slice(0, shown - 1);
  const hidden = rest.length - listed.length;
  // Setup steps are listed on Get started; anything from the feed is in Notifications.
  const moreHref = rest.every((i) => i.source === 'setup')
    ? '/organizer/onboarding'
    : '/organizer/notifications';
  const more = (n: number) => `${count(n)} more ${n === 1 ? 'item' : 'items'}`;
  return (
    <section
      aria-labelledby={headingId}
      className="min-w-0 rounded-brand-card border border-brand-line bg-brand-surface"
    >
      <div className="flex items-baseline justify-between gap-4 px-4 pb-3 pt-4 md:px-6">
        <h2 id={headingId} className="text-brand-body font-semibold text-brand-ink">
          Needs you
          {needs.items.length > 0 && (
            <span className="ml-2 tabular-nums text-brand-ink-3">{count(needs.items.length)}</span>
          )}
        </h2>
        {needs.suggestions > 0 && canAct && (
          <Link href="/organizer/onboarding" className={`text-brand-meta ${LINK}`}>
            {count(needs.suggestions)} optional {needs.suggestions === 1 ? 'step' : 'steps'}
          </Link>
        )}
      </div>
      <div className="flex flex-col gap-6 border-t border-brand-line px-4 py-4 md:px-6 md:py-6">
        {needs.items.length === 0 && (
          <p className="text-brand-ui text-brand-ink-2">
            {failed ? 'We could not check your notifications.' : 'Nothing needs you right now.'}
            {failed && (
              <button type="button" onClick={onRetry} className={`ml-2 text-brand-ui ${LINK}`}>
                Try again
              </button>
            )}
          </p>
        )}
        {next && (
          <StepBlock
            eyebrow={next.itemKey ? 'Do this next' : 'Next step'}
            blocking={next.blocking}
            step={next.step}
            readOnly={!canAct}
          />
        )}
        {listed.length > 0 && (
          /*
            Below `xl` the panel sits ABOVE the events, so it shows the next step alone and counts
            the rest: a column of warnings there pushed "Coming up" off a laptop's first screen.
          */
          <ul className="hidden flex-col border-t border-brand-line xl:flex">
            {listed.map((item) => (
              <li
                key={item.key}
                className="border-b border-brand-line py-3 last:border-b-0 last:pb-0"
              >
                <div className="flex items-start justify-between gap-3">
                  <div className="flex min-w-0 flex-col gap-1">
                    <p className="text-brand-ui font-semibold text-brand-ink">{item.title}</p>
                    {item.detail && (
                      <p className="line-clamp-2 text-brand-meta text-brand-ink-2">{item.detail}</p>
                    )}
                  </div>
                  <BrandStatusPill status={SEVERITY[item.severity].tone}>
                    {SEVERITY[item.severity].label}
                  </BrandStatusPill>
                </div>
                {canAct ? (
                  <Link href={item.href} className={`mt-2 inline-block text-brand-meta ${LINK}`}>
                    {item.actionLabel}
                  </Link>
                ) : (
                  <p className="mt-2 text-brand-meta text-brand-ink-3">{OWNER_DOES_IT}</p>
                )}
              </li>
            ))}
          </ul>
        )}
        {/* Read-only for a role that cannot open the pages these items are fixed on. */}
        {rest.length > 0 &&
          (canAct ? (
            <Link href={moreHref} className={`text-brand-meta xl:hidden ${LINK}`}>
              {more(rest.length)}
            </Link>
          ) : (
            <p className="text-brand-meta text-brand-ink-3 xl:hidden">{more(rest.length)}</p>
          ))}
        {hidden > 0 &&
          (canAct ? (
            <Link href={moreHref} className={`hidden text-brand-meta xl:inline ${LINK}`}>
              {more(hidden)}
            </Link>
          ) : (
            <p className="hidden text-brand-meta text-brand-ink-3 xl:block">{more(hidden)}</p>
          ))}
      </div>
    </section>
  );
}

// ─── Sales by market, one click away ────────────────────────────────────────────

/** "India · INR": the market named by its country, as the admin dashboard names it. */
function marketName(m: { country: string | null; currency: string }): string {
  const name = MARKETS.find((x) => x.code === m.country)?.name;
  return name ? `${name} · ${m.currency}` : m.currency;
}

/**
 * Every market side by side, folded: the figures above answer "how much" for the home market,
 * and this is the detail somebody selling in several countries opens. Each amount is in its own
 * row's currency, and rows are never totalled.
 */
export function MarketsDisclosure({ markets }: { markets: AnalyticsOrganizerMarket[] }) {
  const [open, setOpen] = useState(false);
  const regionId = useId();
  return (
    <section className="min-w-0 rounded-brand-card border border-brand-line bg-brand-surface">
      <button
        type="button"
        aria-expanded={open}
        aria-controls={regionId}
        onClick={() => setOpen((o) => !o)}
        className={`flex w-full items-center justify-between gap-4 rounded-brand-card px-4 py-4 text-left md:px-6 ${RING}`}
      >
        <span className="text-brand-body font-semibold text-brand-ink">
          Sales by market
          <span className="ml-2 tabular-nums text-brand-ink-3">{count(markets.length)}</span>
        </span>
        <ChevronDown
          aria-hidden
          className={`h-4 w-4 shrink-0 text-brand-ink-3 transition-transform duration-200 motion-reduce:transition-none ${open ? 'rotate-180' : ''}`}
        />
      </button>
      <div id={regionId} hidden={!open}>
        <div
          className={`overflow-x-auto border-t border-brand-line ${RING}`}
          tabIndex={0}
          role="region"
          aria-label="Sales by market"
        >
          <table className="w-full text-left text-brand-ui">
            <caption className="sr-only">
              Sales, refunds, bookings and payment failures for each market
            </caption>
            <thead>
              <tr className="text-brand-eyebrow uppercase text-brand-ink-3">
                <th scope="col" className="px-6 py-3 align-bottom font-semibold">
                  Market
                </th>
                {[
                  'Gross sales',
                  'Net proceeds',
                  'Refunds',
                  'Paid bookings',
                  'All bookings',
                  'Payment failures',
                ].map((h) => (
                  <th
                    key={h}
                    scope="col"
                    className="px-3 py-3 text-right align-bottom font-semibold"
                  >
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {markets.map((m) => (
                <tr key={m.currency} className="border-t border-brand-line">
                  <th
                    scope="row"
                    className="whitespace-nowrap px-6 py-3 font-semibold text-brand-ink"
                  >
                    {marketName(m)}
                  </th>
                  {[
                    money(m.grossMinor, m.currency),
                    money(m.netMinor, m.currency),
                    money(m.refundsMinor, m.currency),
                    count(m.paidBookings),
                    count(m.totalBookings),
                    count(m.paymentFailures),
                  ].map((v, i) => (
                    <td
                      key={i}
                      className="whitespace-nowrap px-3 py-3 text-right tabular-nums text-brand-ink"
                    >
                      {v}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </section>
  );
}

// ─── First paint ────────────────────────────────────────────────────────────────

/** The page's shape while its first reads are out, so the real page lands where this stood. */
export function DeskOverviewSkeleton() {
  const block = 'rounded-brand-card bg-brand-sunken motion-safe:animate-pulse';
  return (
    <div
      role="status"
      aria-busy="true"
      aria-label="Loading your overview"
      className="flex flex-col gap-6"
    >
      <div className="flex flex-col gap-2">
        <div className="h-3 w-40 rounded-full bg-brand-sunken" />
        <div className="h-8 w-48 rounded-brand-control bg-brand-sunken" />
      </div>
      <div className={`h-[13.5rem] md:h-[8.5rem] ${block}`} />
      <div className="grid gap-6 xl:grid-cols-[minmax(0,1fr)_20rem]">
        <div className={`h-80 ${block}`} />
        <div className={`h-64 ${block}`} />
      </div>
    </div>
  );
}

/** The page could not load its figures: say so and offer the one thing that helps. */
export function DeskOverviewError({ onRetry }: { onRetry: () => void }) {
  return (
    <div role="alert" className="rounded-brand-card border border-brand-line bg-brand-surface p-6">
      <p className="text-brand-body font-semibold text-brand-ink">
        We could not load your overview.
      </p>
      <p className="mt-1 text-brand-meta text-brand-ink-2">
        Your events and sales are safe. Check your connection and try again.
      </p>
      <button
        type="button"
        onClick={onRetry}
        className={`mt-4 ${brandButtonClasses('secondary', 'md')}`}
      >
        Try again
      </button>
    </div>
  );
}
