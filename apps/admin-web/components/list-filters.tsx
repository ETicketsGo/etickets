'use client';

import { useQuery } from '@tanstack/react-query';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { ChevronDown, Search, SlidersHorizontal, X } from 'lucide-react';
import {
  api,
  Button,
  Input,
  Select,
  Spinner,
  dayWindowInverted,
  describeFilters,
  enumLabel,
  money,
  parseCountryParam,
  parseDayParam,
  type AdminListFilters,
  type FilterDescriptionInput,
} from '@eticketsgo/web-kit';
import { CountryFilter } from './country-filter';

/**
 * The filter bar the finance and operations queues share: payments, refunds, settlements,
 * support and the audit log.
 *
 * ── WHY EVERY FILTER LIVES IN THE URL ──────────────────────────────────────────────
 * "Refunds for this organizer in India last week" is a view somebody wants to come back to and
 * send to a colleague. In component state it was lost on every refresh and could not be linked.
 * The country filter already moved to the query string for that reason (#261); the rest follow it
 * so a link carries the whole question, not one part of it.
 *
 * The action centre's links still work: they name a `status` in the URL, which is now simply the
 * status filter rather than a value read once and then forgotten.
 *
 * ── WHY A DEFAULT IS NOT WRITTEN TO THE URL ────────────────────────────────────────
 * The refund queue opens on REQUESTED. A clean link (`/admin/refunds`) has to keep meaning that,
 * so a value equal to its default is removed from the URL, and "every status" on a queue whose
 * default is not "every status" is written as an explicit empty `status=`.
 */

export type FilterValues<K extends string> = Record<K, string>;

export function useUrlFilters<K extends string>(
  keys: readonly K[],
  defaults: Partial<Record<K, string>> = {},
) {
  const params = useSearchParams();
  const router = useRouter();
  const pathname = usePathname();

  const values = {} as FilterValues<K>;
  for (const k of keys) {
    const raw = params.has(k) ? (params.get(k) ?? '') : (defaults[k] ?? '');
    // The two values the API validates strictly are cleaned here, so a hand-edited link falls
    // back to "not filtered" instead of to a 400 and an empty page.
    if (k === 'country') values[k] = parseCountryParam(raw) ?? '';
    else if (k === 'from' || k === 'to') values[k] = parseDayParam(raw) ?? '';
    else values[k] = raw.trim();
  }

  const write = (next: URLSearchParams) => {
    const query = next.toString();
    // `replace`, not `push`: changing a filter is not a page the back button should step through.
    router.replace(query ? `${pathname}?${query}` : pathname, { scroll: false });
  };

  const set = (patch: Partial<Record<K, string | undefined>>) => {
    const next = new URLSearchParams(params.toString());
    for (const [k, v] of Object.entries(patch) as [K, string | undefined][]) {
      const value = v ?? '';
      if (value === (defaults[k] ?? '')) next.delete(k);
      else next.set(k, value);
    }
    write(next);
  };

  /** Back to the queue as it opens: every filter this bar owns is removed from the URL. */
  const clear = () => {
    const next = new URLSearchParams(params.toString());
    for (const k of keys) next.delete(k);
    write(next);
  };

  const active = keys.some((k) => values[k] !== (defaults[k] ?? ''));
  const from = (values as Record<string, string>).from || undefined;
  const to = (values as Record<string, string>).to || undefined;

  return {
    values,
    set,
    clear,
    /** Whether anything differs from how the queue opens - when "Clear filters" is offered. */
    active,
    /** A window ending before it starts. The list is not asked for until it is fixed. */
    invalidWindow: dayWindowInverted(from, to),
    /** One string that changes whenever any filter does, for resetting the page number. */
    signature: keys.map((k) => `${k}=${values[k]}`).join('&'),
  };
}

/** The shared filters as the API takes them, with empty values dropped. */
export function apiFilters(v: Partial<Record<string, string>>): AdminListFilters {
  return {
    country: v.country || undefined,
    organizationId: v.organizationId || undefined,
    eventId: v.eventId || undefined,
    from: v.from || undefined,
    to: v.to || undefined,
  };
}

/* ── Names for ids ───────────────────────────────────────────────────────────────── */

/**
 * The name of an organizer or event held in the URL by id.
 *
 * A link carries the id - names are not unique and change - so the bar looks the name up to show
 * it. If the lookup fails (deleted, or this admin cannot read that queue) it falls back to a
 * short id rather than to nothing, so the filter is still visibly on.
 */
export function useEntityName(kind: 'organizer' | 'event', id: string | undefined) {
  const { data, isError } = useQuery({
    queryKey: ['admin', 'filter-name', kind, id],
    enabled: Boolean(id),
    staleTime: 5 * 60_000,
    retry: false,
    queryFn: async () =>
      kind === 'organizer'
        ? (await api.organizations.get(id as string)).name
        : (await api.events.get(id as string)).title,
  });
  if (!id) return undefined;
  if (data) return data;
  return isError ? `${kind} ${id.slice(0, 8)}` : undefined;
}

/* ── The typeahead ───────────────────────────────────────────────────────────────── */

interface Option {
  id: string;
  label: string;
  hint?: string;
}

/**
 * A search-as-you-type picker over an existing admin search endpoint.
 *
 * Not a dropdown of every organizer: there are too many to list, and a select box that loads them
 * all is a page that gets slower with every seller the platform signs. Two letters start a search
 * in the database, and the choice is stored as an id.
 */
function EntityPicker({
  label,
  placeholder,
  value,
  valueName,
  onChange,
  search,
  searchKey,
}: {
  label: string;
  placeholder: string;
  value: string | undefined;
  valueName: string | undefined;
  onChange: (id: string | undefined) => void;
  search: (q: string) => Promise<Option[]>;
  /** Extra cache-key parts, e.g. the organizer an event search is scoped to. */
  searchKey: unknown[];
}) {
  const fieldId = useId();
  const listId = `${fieldId}-list`;
  const [text, setText] = useState('');
  const [debounced, setDebounced] = useState('');
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const wrapper = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const t = setTimeout(() => setDebounced(text.trim()), 250);
    return () => clearTimeout(t);
  }, [text]);

  // Closes when focus or a click goes anywhere else, as a native select would.
  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      if (wrapper.current && !wrapper.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, []);

  const results = useQuery({
    queryKey: ['admin', 'filter-search', label, debounced, ...searchKey],
    enabled: open && debounced.length >= 2,
    queryFn: () => search(debounced),
    staleTime: 30_000,
  });
  const options = results.data ?? [];

  const choose = (o: Option) => {
    onChange(o.id);
    setText('');
    setOpen(false);
  };

  if (value) {
    return (
      <div>
        <p className="mb-1.5 block text-[0.8125rem] font-medium text-text-secondary">{label}</p>
        <div className="flex min-w-0 items-center gap-2 rounded-md border border-border-input bg-background-surface py-1.5 pl-3.5 pr-1.5">
          <span className="min-w-0 flex-1 truncate text-[0.9375rem] text-text-primary">
            {valueName ?? <Spinner className="h-4 w-4" />}
          </span>
          <button
            type="button"
            onClick={() => onChange(undefined)}
            aria-label={`Remove the ${label.toLowerCase()} filter`}
            className="rounded-md p-1.5 text-text-muted hover:bg-background-subtle hover:text-text-primary focus-visible:outline focus-visible:outline-2 focus-visible:outline-ring"
          >
            <X className="h-4 w-4" aria-hidden="true" />
          </button>
        </div>
      </div>
    );
  }

  return (
    <div ref={wrapper} className="relative">
      <label
        htmlFor={fieldId}
        className="mb-1.5 block text-[0.8125rem] font-medium text-text-secondary"
      >
        {label}
      </label>
      <div className="relative">
        <Search className="pointer-events-none absolute left-3.5 top-1/2 h-4 w-4 -translate-y-1/2 text-text-muted" />
        <input
          id={fieldId}
          type="text"
          role="combobox"
          aria-expanded={open && debounced.length >= 2}
          aria-controls={listId}
          aria-autocomplete="list"
          aria-activedescendant={
            open && options[active] ? `${listId}-${options[active].id}` : undefined
          }
          autoComplete="off"
          value={text}
          placeholder={placeholder}
          onFocus={() => setOpen(true)}
          onChange={(e) => {
            setText(e.target.value);
            setActive(0);
            setOpen(true);
          }}
          onKeyDown={(e) => {
            if (e.key === 'ArrowDown') {
              e.preventDefault();
              setActive((i) => Math.min(i + 1, Math.max(options.length - 1, 0)));
            } else if (e.key === 'ArrowUp') {
              e.preventDefault();
              setActive((i) => Math.max(i - 1, 0));
            } else if (e.key === 'Enter' && options[active]) {
              e.preventDefault();
              choose(options[active]);
            } else if (e.key === 'Escape') {
              setOpen(false);
            }
          }}
          className="w-full rounded-md border border-border-input bg-background-surface py-2.5 pl-10 pr-3.5 text-[0.9375rem] text-text-primary placeholder:text-text-muted transition-[box-shadow,border-color] duration-150 focus:border-ring focus:outline-none focus:ring-4 focus:ring-ring/15"
        />
      </div>
      {open && debounced.length >= 2 && (
        <ul
          id={listId}
          role="listbox"
          aria-label={`${label} results`}
          className="absolute left-0 right-0 z-20 mt-1 max-h-64 overflow-auto rounded-lg border border-border bg-background-elevated p-1 shadow-lg"
        >
          {results.isLoading && (
            <li className="flex items-center gap-2 px-2.5 py-2 text-caption text-text-secondary">
              <Spinner className="h-4 w-4" /> Searching
            </li>
          )}
          {results.isError && (
            <li className="px-2.5 py-2 text-caption text-status-error">
              We could not search. Try again.
            </li>
          )}
          {!results.isLoading && !results.isError && options.length === 0 && (
            <li className="px-2.5 py-2 text-caption text-text-secondary">
              Nothing matches &quot;{debounced}&quot;.
            </li>
          )}
          {options.map((o, i) => (
            <li
              key={o.id}
              id={`${listId}-${o.id}`}
              role="option"
              aria-selected={i === active}
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => choose(o)}
              onMouseEnter={() => setActive(i)}
              className={`cursor-pointer rounded-md px-2.5 py-2 text-[0.9375rem] text-text-primary ${
                i === active ? 'bg-background-subtle' : ''
              }`}
            >
              <span className="block truncate">{o.label}</span>
              {o.hint && (
                <span className="block truncate text-caption text-text-muted">{o.hint}</span>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** Organizers, searched by name through the organizer review queue's own search. */
export function OrganizerPicker({
  value,
  onChange,
}: {
  value: string | undefined;
  onChange: (id: string | undefined) => void;
}) {
  const name = useEntityName('organizer', value);
  return (
    <EntityPicker
      label="Organizer"
      placeholder="Type 2 letters of a name"
      value={value}
      valueName={name}
      onChange={onChange}
      searchKey={[]}
      search={async (q) => {
        const page = await api.admin.organizers({ page: 1, pageSize: 8, q });
        return page.data.map((o) => ({
          id: o.id,
          label: o.name,
          hint: [o.registeredCountry, enumLabel(o.status)].filter(Boolean).join(' - '),
        }));
      }}
    />
  );
}

/**
 * Events, searched by title through the event moderation queue's own search - and only the chosen
 * organizer's events once an organizer is picked, so the two filters cannot contradict each other.
 */
export function EventPicker({
  value,
  onChange,
  organizationId,
}: {
  value: string | undefined;
  onChange: (id: string | undefined) => void;
  organizationId: string | undefined;
}) {
  const name = useEntityName('event', value);
  return (
    <EntityPicker
      label="Event"
      placeholder="Type 2 letters of a title"
      value={value}
      valueName={name}
      onChange={onChange}
      searchKey={[organizationId]}
      search={async (q) => {
        const page = await api.admin.events({
          page: 1,
          pageSize: 8,
          q,
          ...(organizationId ? { groupBy: 'organizer' as const, groupKey: organizationId } : {}),
        });
        return page.data.map((e) => ({
          id: e.id,
          label: e.title,
          hint: [e.organization?.name, e.venue?.city].filter(Boolean).join(' - '),
        }));
      }}
    />
  );
}

/* ── The bar ─────────────────────────────────────────────────────────────────────── */

type SharedKey = 'country' | 'organizationId' | 'eventId' | 'status' | 'from' | 'to';

/**
 * Country, organizer, event, status and a UTC day window, plus any controls a queue adds.
 *
 * One column on a phone, three on a laptop: these screens are used on both, and a row of seven
 * controls is the shape that ends up wider than its box.
 */
export function FilterBar({
  filters,
  statuses,
  statusLabel = 'Status',
  everyStatusLabel = 'Every status',
  statusName = enumLabel,
  countryHint,
  children,
  show = { organizer: true, event: true },
}: {
  filters: {
    values: Partial<Record<SharedKey, string>>;
    set: (patch: Partial<Record<SharedKey, string | undefined>>) => void;
    clear: () => void;
    active: boolean;
    invalidWindow: boolean;
  };
  /** The entity's real lifecycle values. Omit for a queue with no status of its own. */
  statuses?: readonly string[];
  statusLabel?: string;
  everyStatusLabel?: string;
  /**
   * The words for a status in the dropdown. Pass the same function the list's pills use, so the
   * filter says "Waiting for a decision" over a list that says it too, not "Requested".
   */
  statusName?: (status: string) => string;
  /** What "country" means on this queue, when it is not where the sale happened. */
  countryHint?: string;
  /** Queue-specific controls (kind, action), placed after the shared ones. */
  children?: ReactNode;
  show?: { organizer?: boolean; event?: boolean };
}) {
  const v = filters.values;
  const today = new Date().toISOString().slice(0, 10);
  const gridId = useId();
  const [openOnPhone, setOpenOnPhone] = useState(false);
  /*
    How many of the bar's own filters are on, said beside "Clear filters". A filter set last week
    and forgotten is the usual reason a queue looks empty, and a count is visible from across the
    page where a filled-in field among seven is not.
  */
  const on = (['country', 'organizationId', 'eventId', 'status', 'from', 'to'] as const).filter(
    (k) => Boolean(v[k]),
  ).length;
  return (
    <div className="space-y-3">
      {/*
        On a phone the six controls stood a full screen tall above the first result. They fold
        behind one button there, which says how many are on so a forgotten filter is still seen;
        from `sm` up they are always shown, as before.
      */}
      <button
        type="button"
        aria-expanded={openOnPhone}
        aria-controls={gridId}
        onClick={() => setOpenOnPhone((o) => !o)}
        className="flex w-full items-center justify-between gap-2 rounded-md border border-border-input bg-background-surface px-3.5 py-2.5 text-ui font-medium text-text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring sm:hidden"
      >
        <span className="inline-flex items-center gap-2">
          <SlidersHorizontal className="h-4 w-4 text-text-muted" aria-hidden />
          Filters
          {on > 0 && (
            <span className="rounded-full bg-tint-primary px-2 py-0.5 text-micro font-semibold text-action-primary">
              {on} on
            </span>
          )}
        </span>
        <ChevronDown
          className={`h-4 w-4 text-text-muted transition-transform ${openOnPhone ? 'rotate-180' : ''}`}
          aria-hidden
        />
      </button>
      <div
        id={gridId}
        className={`${openOnPhone ? 'grid' : 'hidden'} gap-3 sm:grid sm:grid-cols-2 lg:grid-cols-3`}
      >
        <div>
          <CountryFilter
            label="Country"
            value={v.country || undefined}
            onChange={(code) => filters.set({ country: code })}
          />
        </div>
        {show.organizer !== false && (
          <OrganizerPicker
            value={v.organizationId || undefined}
            onChange={(id) =>
              // A new organizer clears the event: the old event belonged to the old organizer.
              filters.set({ organizationId: id, eventId: undefined })
            }
          />
        )}
        {show.event !== false && (
          <EventPicker
            value={v.eventId || undefined}
            organizationId={v.organizationId || undefined}
            onChange={(id) => filters.set({ eventId: id })}
          />
        )}
        {statuses && (
          <Select
            label={statusLabel}
            value={v.status ?? ''}
            onChange={(e) => filters.set({ status: e.target.value })}
          >
            <option value="">{everyStatusLabel}</option>
            {statuses.map((s) => (
              <option key={s} value={s}>
                {statusName(s)}
              </option>
            ))}
          </Select>
        )}
        {children}
        <div className="grid grid-cols-2 gap-3">
          <Input
            label="From (UTC)"
            type="date"
            value={v.from ?? ''}
            max={v.to || today}
            onChange={(e) => filters.set({ from: e.target.value })}
          />
          <Input
            label="To (UTC)"
            type="date"
            value={v.to ?? ''}
            min={v.from || undefined}
            onChange={(e) => filters.set({ to: e.target.value })}
            error={filters.invalidWindow ? 'The end date is before the start date.' : undefined}
          />
        </div>
      </div>
      <div className="flex flex-wrap items-center justify-between gap-2">
        {/*
          The country hint lives here with the date rule rather than under the country field. Under
          the field it made that one cell taller than its row, and every control after it sat out
          of line with the one beside it.
        */}
        <p className={`text-caption text-text-muted ${openOnPhone ? '' : 'hidden sm:block'}`}>
          {countryHint
            ? `Country: ${countryHint.charAt(0).toLowerCase()}${countryHint.slice(1)} `
            : ''}
          Dates are whole days in UTC. Both days are included.
        </p>
        {filters.active && (
          <div className="flex items-center gap-2">
            {on > 0 && (
              <span className="rounded-full bg-tint-primary px-2.5 py-0.5 text-micro font-semibold text-action-primary">
                {on} {on === 1 ? 'filter' : 'filters'} on
              </span>
            )}
            <Button variant="ghost" size="sm" onClick={filters.clear}>
              Clear filters
            </Button>
          </div>
        )}
      </div>
    </div>
  );
}

/**
 * "No refunds match: status Requested, country India, from 1 Oct 2026 (UTC)." with a way out.
 *
 * An empty list on its own reads as "there are none", and the operator who set a window last
 * week and forgot it is exactly the one who needs to be told which filters did this.
 */
export function useFilterDescription(
  values: Partial<Record<string, string>>,
  extra?: FilterDescriptionInput['extra'],
  q?: string,
): string {
  const organizer = useEntityName('organizer', values.organizationId || undefined);
  const event = useEntityName('event', values.eventId || undefined);
  return describeFilters({
    status: values.status || undefined,
    extra,
    country: values.country || undefined,
    organizer: values.organizationId ? (organizer ?? 'the chosen organizer') : undefined,
    event: values.eventId ? (event ?? 'the chosen event') : undefined,
    from: values.from || undefined,
    to: values.to || undefined,
    q: q || undefined,
  });
}

/* ── Totals per currency ─────────────────────────────────────────────────────────── */

/**
 * What the filtered list adds up to, one total per currency.
 *
 * Read from the same grouped summary the page already trusts, grouped by currency, so it is
 * computed over EVERY matching row in the database rather than the fifteen on screen, and under
 * exactly the filters the list is using. Never one number: rupees and dollars are not added.
 */
export function CurrencyTotals({
  resource,
  status,
  q,
  filters,
  enabled = true,
}: {
  resource: 'payments' | 'refunds' | 'settlements';
  status?: string;
  q?: string;
  filters: AdminListFilters;
  enabled?: boolean;
}) {
  const call = api.admin.grouped[resource];
  const { data, isLoading, isError } = useQuery({
    /*
      Its own key, not the grouped summary's. Sharing `['admin', 'grouped', ...]` meant choosing
      "Currency" in the summary was answered from this strip's cache with no request at all, so
      the summary and the strip could not be told apart and the summary never visibly refetched.
    */
    queryKey: ['admin', 'currency-totals', resource, status, q, filters],
    enabled,
    queryFn: () => call({ groupBy: 'currency', status, q, ...filters }),
  });
  if (!enabled) return null;
  return (
    <div className="flex flex-wrap items-baseline gap-x-4 gap-y-1 text-caption text-text-secondary">
      <span className="font-medium text-text-primary">
        {resource === 'settlements' ? 'Payable per currency' : 'Total per currency'}
      </span>
      {isLoading && <Spinner className="h-3.5 w-3.5" />}
      {isError && <span className="text-status-error">We could not add these up.</span>}
      {data && data.groups.length === 0 && <span>Nothing to add up.</span>}
      {data?.groups.map((g) => (
        <span key={g.key ?? g.label} className="tabular-nums">
          {g.totals.map((t) => money(t.totalMinor, t.currency.toUpperCase())).join(' ')}{' '}
          <span className="text-text-muted">
            ({g.count.toLocaleString()} {g.count === 1 ? 'row' : 'rows'})
          </span>
        </span>
      ))}
    </div>
  );
}
