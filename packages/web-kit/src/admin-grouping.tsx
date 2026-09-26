'use client';

import { useQuery } from '@tanstack/react-query';
import { Layers, X } from 'lucide-react';
import {
  api,
  ADMIN_GROUP_KEY_NONE,
  type AdminGroupBy,
  type AdminGroupQuery,
  type AdminGroupRow,
} from './api';
import { Select, Spinner } from './components';
import { money } from './format';

/**
 * The grouped summary above an admin queue.
 *
 * ── THE QUESTION THIS ANSWERS ──────────────────────────────────────────────────────
 * Every admin list pages through rows, which answers "find this booking" and nothing else. The
 * questions an operator actually arrives with are about the shape of the whole set: how much are
 * we doing in India, which organizer is producing the refunds, is one event responsible for all
 * of it. Fifteen rows at a time cannot answer any of them.
 *
 * So this sits above the list: one row per group with a count and, where the resource is money, a
 * total PER CURRENCY. Choosing a group narrows the list underneath to it. The summary says where
 * to look and the list says at what.
 *
 * ── WHY IT OWNS ITS OWN QUERY ──────────────────────────────────────────────────────
 * Six pages use it, and a summary fetched by the page would be a summary six pages each have to
 * remember to invalidate, key and put in a loading state. The selection stays with the page,
 * because the page's list query is what has to change when it moves.
 */

/** Which group is selected, if any. Held by the page, because the list query needs it too. */
export interface GroupSelection {
  groupBy?: AdminGroupBy;
  /** `ADMIN_GROUP_KEY_NONE` for the group with no value. Undefined means nothing selected yet. */
  groupKey?: string;
}

/** Which queue this can sit above. Each one is a separate endpoint with its own capability. */
export type GroupableAdminResource =
  'bookings' | 'payments' | 'refunds' | 'settlements' | 'events' | 'organizers';

const CALLS: Record<GroupableAdminResource, (params: AdminGroupQuery) => Promise<unknown>> = {
  bookings: api.admin.grouped.bookings,
  payments: api.admin.grouped.payments,
  refunds: api.admin.grouped.refunds,
  settlements: api.admin.grouped.settlements,
  events: api.admin.grouped.events,
  organizers: api.admin.grouped.organizers,
};

const LABELS: Record<AdminGroupBy, string> = {
  country: 'Country',
  organizer: 'Organizer',
  event: 'Event',
  currency: 'Currency',
};

export function GroupedSummary({
  resource,
  options,
  value,
  onChange,
  status,
  q,
}: {
  /** Which admin queue this sits above. Decides the endpoint and the authorisation. */
  resource: GroupableAdminResource;
  /** The groupings this queue supports, in the order to offer them. */
  options: readonly AdminGroupBy[];
  value: GroupSelection;
  onChange: (next: GroupSelection) => void;
  /*
    The filters the LIST below is showing, passed straight through.

    These are required in spirit even though they are optional in type: a summary counted over
    every row, sitting above a list filtered to REQUESTED refunds, reads "India - 1 row" over an
    empty table. Both numbers are correct and the pair is useless.
  */
  status?: string;
  q?: string;
}) {
  const { groupBy } = value;
  const { data, isLoading, isError } = useQuery({
    // `status` and `q` are IN the key: they change the answer, so a cached count taken under a
    // different filter is a wrong number, not a stale one.
    queryKey: ['admin', 'grouped', resource, groupBy, status, q],
    // Not fetched at all until a grouping is chosen: the default view is the plain list, and a
    // summary nobody asked for is an aggregate query on every admin page load.
    enabled: Boolean(groupBy),
    queryFn: () =>
      CALLS[resource]({ groupBy: groupBy as AdminGroupBy, status, q }) as Promise<{
        groups: AdminGroupRow[];
        truncated: boolean;
      }>,
  });

  return (
    /*
      A toolbar block, not a Card. Half these queues put their table inside a card already, so a
      card here made a box inside a box; a tinted strip directly above the rows reads as "these
      results, grouped", which is what it is.
    */
    <div className="space-y-3 rounded-lg border border-border bg-background-subtle p-3">
      <div className="flex flex-wrap items-end gap-3">
        <div className="w-full sm:w-56">
          <Select
            label="Group by"
            value={groupBy ?? ''}
            onChange={(e) => {
              const next = e.target.value as AdminGroupBy | '';
              /*
                Changing the grouping clears the selection: a key from the old grouping means
                nothing in the new one, and carrying it over would scope the list to a group that
                is no longer on screen.
              */
              onChange(next ? { groupBy: next } : {});
            }}
          >
            <option value="">No grouping</option>
            {options.map((o) => (
              <option key={o} value={o}>
                {LABELS[o]}
              </option>
            ))}
          </Select>
        </div>
        {isLoading && (
          <div className="flex items-center gap-2 pb-2 text-caption text-text-secondary">
            <Spinner className="h-4 w-4" />
            <span>Counting…</span>
          </div>
        )}
      </div>

      {isError && (
        <p role="alert" className="text-caption text-status-error">
          We could not count these. The list below is unaffected.
        </p>
      )}

      {groupBy && data && data.groups.length > 0 && (
        <div className="space-y-2">
          {/*
            Buttons in a wrapping row, not a table. These screens are read on a laptop and on a
            phone, and a table of counts is the shape that ends up wider than its box - the defect
            four admin tables already had. A chip that wraps cannot.
          */}
          <div className="flex flex-wrap gap-2">
            {data.groups.map((g) => (
              <GroupChip
                key={g.key ?? ADMIN_GROUP_KEY_NONE}
                group={g}
                selected={value.groupKey === (g.key ?? ADMIN_GROUP_KEY_NONE)}
                onSelect={() => onChange({ groupBy, groupKey: g.key ?? ADMIN_GROUP_KEY_NONE })}
              />
            ))}
          </div>
          {value.groupKey !== undefined && (
            <button
              type="button"
              onClick={() => onChange({ groupBy })}
              className="inline-flex items-center gap-1.5 rounded-full border border-border-input px-3 py-1.5 text-caption text-text-secondary hover:bg-background-subtle focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
            >
              <X className="h-3.5 w-3.5" aria-hidden="true" />
              Show all groups
            </button>
          )}
          {data.truncated && (
            <p className="text-caption text-text-muted">
              {/*
                The list below is still complete; only the summary is capped. Saying so is the
                difference between a cap and a total that is silently wrong.
              */}
              Showing the {data.groups.length} largest groups. The list below is not limited.
            </p>
          )}
        </div>
      )}

      {groupBy && data && data.groups.length === 0 && (
        <p className="text-caption text-text-secondary">Nothing to group yet.</p>
      )}
    </div>
  );
}

function GroupChip({
  group,
  selected,
  onSelect,
}: {
  group: AdminGroupRow;
  selected: boolean;
  onSelect: () => void;
}) {
  /*
    Selection is stated in WORDS as well as colour - `aria-pressed`, and a count line that reads
    "selected" - because a chip that differs from its neighbours only by a fill is a chip nobody
    on a screen reader or a greyscale display can tell apart. Four admin badges had exactly that.
  */
  return (
    <button
      type="button"
      aria-pressed={selected}
      onClick={onSelect}
      className={`flex min-w-0 max-w-full flex-col items-start gap-0.5 rounded-lg border px-3 py-2 text-left focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring ${
        selected
          ? 'border-action-primary bg-tint-primary'
          : 'border-border-input bg-background-surface hover:bg-background-elevated'
      }`}
    >
      <span className="flex items-center gap-1.5 truncate text-body font-medium text-text-primary">
        {selected && <Layers className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />}
        <span className="truncate">{group.label}</span>
      </span>
      <span className="text-caption tabular-nums text-text-secondary">
        {group.count.toLocaleString()} {group.count === 1 ? 'row' : 'rows'}
        {selected ? ' · selected' : ''}
      </span>
      {group.totals.length > 0 && (
        <span className="text-caption tabular-nums text-text-secondary">
          {/*
            One amount per currency, joined - never added together. A group selling in INR and USD
            has two totals, and summing them is the bug that once printed dollars as rupees on the
            payouts screen.
          */}
          {group.totals.map((t) => money(t.totalMinor, t.currency)).join(' · ')}
        </span>
      )}
    </button>
  );
}
