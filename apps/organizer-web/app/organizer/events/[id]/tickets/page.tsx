'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useParams } from 'next/navigation';
import { useState } from 'react';
import { CalendarClock, Plus, Ticket } from 'lucide-react';
import {
  api,
  Button,
  ButtonLink,
  Card,
  Dialog,
  Input,
  Menu,
  ProgressMeter,
  Select,
  EmptyState,
  Skeleton,
  StatusBadge,
  ErrorState,
  useToast,
  errorMessage,
  money,
  currencySymbol,
  currencyForCountry,
  dateTime,
  type EventSession,
  type MenuItem,
  type TicketType,
} from '@eticketsgo/web-kit';
import { venueInputZone } from '@/lib/zoned-time';
import {
  addFormState,
  firstInvalidField,
  pluralOf,
  priceLabel,
  resolveSessionId,
  ticketWords,
  validateTicketType,
  validateTicketTypeEdit,
  withArticle,
  type TicketTypeErrors,
  type TicketTypeFields,
} from '@/lib/ticket-type-form';

/** The add form's input ids, so a problem found on submit can put the cursor on its field. */
const ADD_IDS: Record<keyof TicketTypeFields, string> = {
  eventSessionId: 'tt-session',
  name: 'tt-name',
  priceMajor: 'tt-price',
  quantityTotal: 'tt-qty',
  maxPerOrder: 'tt-max',
};
const EDIT_IDS: Record<keyof TicketTypeFields, string> = {
  eventSessionId: '',
  name: 'tt-edit-name',
  priceMajor: 'tt-edit-price',
  quantityTotal: 'tt-edit-qty',
  maxPerOrder: 'tt-edit-max',
};
const CHOOSE_NOTE_ID = 'tt-choose-note';

/** Focus a field once React has drawn the error under it, and bring it into view. */
function focusField(id: string) {
  if (!id) return;
  requestAnimationFrame(() => {
    const el = document.getElementById(id);
    if (!el) return;
    el.focus({ preventScroll: true });
    el.scrollIntoView({ block: 'center' });
  });
}

const EMPTY_ADD = { name: '', priceMajor: '', quantityTotal: '', maxPerOrder: '6' };

export default function TicketsTab() {
  const { id } = useParams<{ id: string }>();
  const qc = useQueryClient();
  const toast = useToast();
  const [editing, setEditing] = useState<TicketType | null>(null);
  const [editForm, setEditForm] = useState({
    name: '',
    priceMajor: '',
    quantityTotal: '',
    maxPerOrder: '',
  });
  const [editSubmitted, setEditSubmitted] = useState(false);
  const [deleting, setDeleting] = useState<TicketType | null>(null);
  const invalidate = () => qc.invalidateQueries({ queryKey: ['event', id] });
  const {
    data: event,
    isLoading,
    isError,
    refetch,
  } = useQuery({
    queryKey: ['event', id],
    queryFn: () => api.events.get(id),
  });

  /*
    The currency this event actually sells in, from where it is.

    The two price fields below were labelled "Price (₹)" and the list formatted every
    amount with `money()`, which falls back to rupees. That was harmless while the server
    also assumed INR everywhere; now that a ticket type is created in the venue's currency,
    a hardcoded ₹ would be an outright lie — an organizer in Idaho typing 499 into a field
    marked ₹ and getting $499.

    Derived with the same helper the API uses, so the label and the stored value cannot
    disagree. The label names the code as well as the symbol, as the create wizard does: "$"
    alone is several currencies.
  */
  const currency = currencyForCountry(event?.venue?.country) ?? 'INR';
  const symbol = currencySymbol(currency);
  // The event's own words - "Performance", "Match", "Pass" - from the wizard's table.
  const words = ticketWords(event?.category);
  const ticketLower = words.ticket.toLowerCase();
  const isFree = event?.isFree ?? false;
  // Show times in the venue's zone, never the browser's - the same rule as the Sessions page.
  const zone = venueInputZone(event?.venue);
  const venueTz = zone.known ? zone.zone : undefined;

  /*
    The session the organizer picked. Empty means "not picked", and `resolveSessionId` turns
    that into the only session when there is just one - so a one-night event never asks.
  */
  const [pickedSession, setPickedSession] = useState('');
  const [form, setForm] = useState(EMPTY_ADD);
  const [touched, setTouched] = useState<Partial<Record<keyof TicketTypeFields, boolean>>>({});
  const [submitted, setSubmitted] = useState(false);

  const sessions = event?.sessions ?? [];
  const sessionId = resolveSessionId(sessions, pickedSession);
  const chosen = sessions.find((s) => s.id === sessionId);
  const errors = validateTicketType(
    { eventSessionId: sessionId, ...form },
    {
      words,
      isFree,
      existingNames: (chosen?.ticketTypes ?? []).map((t) => t.name),
      sessionIds: sessions.map((s) => s.id),
    },
  );
  // Inline, as in the wizard: a field's problem shows once it was left, or when Add is pressed.
  const shown = (k: keyof TicketTypeFields) => (submitted || touched[k] ? errors[k] : undefined);
  const leave = (k: keyof TicketTypeFields) => () => setTouched((t) => ({ ...t, [k]: true }));
  const state = addFormState(sessions, pickedSession, words);

  const add = useMutation({
    mutationFn: () =>
      api.events.addTicketType({
        eventSessionId: sessionId,
        name: form.name,
        // A free event has no price to ask for, and 0 is the only one the API accepts for it.
        priceMinor: isFree ? 0 : Math.round(Number(form.priceMajor) * 100),
        quantityTotal: Number(form.quantityTotal),
        maxPerOrder: Number(form.maxPerOrder) || 10,
      }),
    onSuccess: () => {
      toast.push(`${words.ticket} added.`, 'success');
      setForm({ ...form, name: '', priceMajor: '', quantityTotal: '' });
      setTouched({});
      setSubmitted(false);
      invalidate();
    },
    onError: (e) => toast.push(errorMessage(e), 'error'),
  });

  const submitAdd = () => {
    setSubmitted(true);
    const first = firstInvalidField(errors);
    if (first) {
      focusField(ADD_IDS[first]);
      return;
    }
    add.mutate();
  };

  /** "Add ticket type" on a session's card: that session, and straight to the name. */
  const addFor = (s: EventSession) => {
    setPickedSession(s.id);
    setTouched({});
    setSubmitted(false);
    focusField(ADD_IDS.name);
  };

  const committed = (t: TicketType) =>
    (t.inventory?.quantitySold ?? 0) + (t.inventory?.quantityHeld ?? 0);
  const priceLocked = (editing?.inventory?.quantitySold ?? 0) > 0;
  const editCurrency = editing?.currency ?? currency;
  const editErrors: TicketTypeErrors = validateTicketTypeEdit(editForm, {
    isFree,
    priceLocked,
    committed: editing ? committed(editing) : 0,
  });
  const shownEdit = (k: keyof TicketTypeFields) => (editSubmitted ? editErrors[k] : undefined);

  const saveEdit = useMutation({
    mutationFn: () =>
      api.events.updateTicketType(editing!.id, {
        name: editForm.name.trim() || undefined,
        priceMinor:
          editForm.priceMajor === '' ? undefined : Math.round(Number(editForm.priceMajor) * 100),
        quantityTotal: editForm.quantityTotal === '' ? undefined : Number(editForm.quantityTotal),
        maxPerOrder: editForm.maxPerOrder === '' ? undefined : Number(editForm.maxPerOrder),
      }),
    onSuccess: () => {
      toast.push(`${words.ticket} updated.`, 'success');
      setEditing(null);
      invalidate();
    },
    onError: (e) => toast.push(errorMessage(e), 'error'),
  });

  /* Save is never greyed out: pressing it with a problem says what the problem is. */
  const submitEdit = () => {
    setEditSubmitted(true);
    const first = firstInvalidField(editErrors);
    if (first) {
      focusField(EDIT_IDS[first]);
      return;
    }
    saveEdit.mutate();
  };

  const toggleActive = useMutation({
    mutationFn: (t: TicketType) =>
      api.events.updateTicketType(t.id, { status: t.status === 'ACTIVE' ? 'INACTIVE' : 'ACTIVE' }),
    onSuccess: () => {
      toast.push('Status updated.', 'success');
      invalidate();
    },
    onError: (e) => toast.push(errorMessage(e), 'error'),
  });

  const del = useMutation({
    mutationFn: (t: TicketType) => api.events.deleteTicketType(t.id),
    onSuccess: () => {
      toast.push(`${words.ticket} deleted.`, 'success');
      setDeleting(null);
      invalidate();
    },
    onError: (e) => toast.push(errorMessage(e), 'error'),
  });

  const openEdit = (t: TicketType) => {
    setEditing(t);
    setEditSubmitted(false);
    setEditForm({
      name: t.name,
      priceMajor: String(t.priceMinor / 100),
      quantityTotal: String(t.quantityTotal),
      maxPerOrder: String(t.maxPerOrder),
    });
  };

  /*
    A row's less frequent actions, in one labelled menu. Delete is not offered for a ticket
    type with sales or holds - the API refuses it - and the menu says why in words, where a
    greyed-out button with a hover-only title used to.
  */
  const moreItems = (t: TicketType): MenuItem[] => [
    {
      label: t.status === 'ACTIVE' ? 'Deactivate (stop selling)' : 'Activate (sell again)',
      onSelect: () => toggleActive.mutate(t),
    },
    { kind: 'separator' },
    committed(t) > 0
      ? { kind: 'note', label: 'Delete', reason: 'It has sales or holds. Deactivate it instead.' }
      : { label: 'Delete', danger: true, onSelect: () => setDeleting(t) },
  ];

  if (isError)
    return (
      <ErrorState message="We couldn't load this. Please try again." onRetry={() => refetch()} />
    );
  if (isLoading || !event) return <Skeleton className="h-64 w-full" />;

  const when = (s: EventSession) => dateTime(s.startsAt, undefined, venueTz);
  const sessionName = (s: EventSession, i: number) =>
    `${words.session} ${i + 1}: ${when(s)}${s.status === 'CANCELLED' ? ' (cancelled)' : ''}`;

  // Nothing to sell a ticket for yet: say where to go, rather than draw a form that cannot work.
  if (state.kind === 'no-sessions')
    return (
      <EmptyState
        icon={CalendarClock}
        tone="teal"
        title={`Add ${withArticle(words.session)} first`}
        hint={state.message}
        action={
          <ButtonLink href={`/organizer/events/${id}/sessions`} icon={Plus}>
            Go to Sessions
          </ButtonLink>
        }
      />
    );

  return (
    <div className="grid gap-6 lg:grid-cols-3">
      <div className="space-y-4 lg:col-span-2">
        {sessions.map((s, i) => {
          const isChosen = sessions.length > 1 && s.id === sessionId;
          const label = `${words.session} ${i + 1}`;
          return (
            <div key={s.id} data-testid="tt-session-card">
              <Card
                padding="md"
                className={isChosen ? 'border-action-primary ring-1 ring-action-primary' : ''}
              >
                {/*
                  Not Card's own title/action row: that one never wraps, and at 390px the
                  button squeezed the date onto two lines. This one drops the button under the
                  date when they do not fit side by side.
                */}
                <div className="mb-4 flex flex-wrap items-start justify-between gap-x-3 gap-y-2">
                  <h2 className="flex min-w-0 flex-col gap-0.5 text-title font-semibold text-text-primary">
                    <span className="text-micro font-semibold uppercase tracking-wide text-text-muted">
                      {label}
                      {s.status === 'CANCELLED' ? ' - cancelled' : ''}
                      {isChosen ? ' - adding here' : ''}
                    </span>
                    <span className="tabular-nums">{when(s)}</span>
                  </h2>
                  {sessions.length > 1 && (
                    <Button
                      size="sm"
                      variant="tinted"
                      icon={Plus}
                      className="shrink-0 whitespace-nowrap"
                      aria-label={`Add ${ticketLower} for ${label.toLowerCase()}`}
                      onClick={() => addFor(s)}
                    >
                      Add {ticketLower}
                    </Button>
                  )}
                </div>
                {s.ticketTypes && s.ticketTypes.length > 0 ? (
                  <ul className="divide-y divide-border">
                    {s.ticketTypes.map((t) => (
                      <li
                        key={t.id}
                        className="grid gap-3 py-3 first:pt-0 last:pb-0 sm:grid-cols-[minmax(0,1fr)_minmax(0,11rem)_auto] sm:items-center"
                      >
                        <div className="min-w-0">
                          <div className="flex flex-wrap items-center gap-2">
                            <span className="break-words font-medium text-text-primary">
                              {t.name}
                            </span>
                            {t.status !== 'ACTIVE' && <StatusBadge status={t.status} />}
                          </div>
                          <p className="mt-0.5 text-caption tabular-nums text-text-secondary">
                            {/* The ticket's OWN currency, not the event's: an older ticket
                                type may predate a venue change and is still priced in what it
                                was sold in. */}
                            {isFree ? 'Free' : money(t.priceMinor, t.currency ?? currency)}
                            {` - max ${t.maxPerOrder} per order`}
                            {(t.inventory?.quantityHeld ?? 0) > 0
                              ? ` - ${t.inventory?.quantityHeld} held`
                              : ''}
                          </p>
                        </div>
                        <ProgressMeter
                          size="sm"
                          value={t.inventory?.quantitySold ?? 0}
                          max={t.quantityTotal}
                          label={`${t.name}: ${t.inventory?.quantitySold ?? 0} of ${t.quantityTotal} sold`}
                        />
                        <div className="flex items-center gap-1.5">
                          <Button size="sm" variant="outline" onClick={() => openEdit(t)}>
                            Edit
                          </Button>
                          <Menu
                            trigger="icon"
                            size="sm"
                            label={`More actions for ${t.name}`}
                            items={moreItems(t)}
                          />
                        </div>
                      </li>
                    ))}
                  </ul>
                ) : (
                  <p className="text-sm text-text-muted">No {pluralOf(words.ticket)} yet.</p>
                )}
              </Card>
            </div>
          );
        })}
      </div>

      <div className="lg:sticky lg:top-4 lg:self-start">
        <Card title={`Add ${ticketLower}`} padding="md">
          <form
            className="space-y-3"
            noValidate
            aria-label={`Add ${ticketLower}`}
            onSubmit={(e) => {
              e.preventDefault();
              submitAdd();
            }}
          >
            {sessions.length === 1 && chosen ? (
              /*
                One session: nothing to choose, so it is chosen - and said, so the organizer
                can see which date this ticket type is for.
              */
              <p
                className="flex items-start gap-2 rounded-md bg-background-subtle px-3 py-2 text-caption text-text-secondary"
                data-testid="tt-only-session"
              >
                <Ticket className="mt-0.5 h-4 w-4 shrink-0 text-text-muted" aria-hidden />
                <span>
                  On sale for{' '}
                  <span className="font-medium text-text-primary">{sessionName(chosen, 0)}</span>
                </span>
              </p>
            ) : (
              <Select
                id={ADD_IDS.eventSessionId}
                label={words.session}
                value={sessionId}
                error={shown('eventSessionId')}
                aria-invalid={Boolean(shown('eventSessionId'))}
                onBlur={leave('eventSessionId')}
                onChange={(e) => setPickedSession(e.target.value)}
              >
                <option value="">Select {withArticle(words.session)}</option>
                {sessions.map((s, i) => (
                  <option key={s.id} value={s.id}>
                    {sessionName(s, i)}
                  </option>
                ))}
              </Select>
            )}
            <Input
              id={ADD_IDS.name}
              label="Name"
              required
              value={form.name}
              error={shown('name')}
              onBlur={leave('name')}
              onChange={(e) => setForm({ ...form, name: e.target.value })}
            />
            {/* No price on a free event: a question that does not apply. */}
            {isFree ? (
              <p className="text-caption text-text-muted">
                This is a free event, so there is no price to set.
              </p>
            ) : (
              <Input
                id={ADD_IDS.priceMajor}
                label={priceLabel(currency, symbol)}
                type="number"
                inputMode="decimal"
                min={0}
                required
                placeholder="0.00"
                className="tabular-nums"
                value={form.priceMajor}
                error={shown('priceMajor')}
                onBlur={leave('priceMajor')}
                onChange={(e) => setForm({ ...form, priceMajor: e.target.value })}
              />
            )}
            <div className="grid grid-cols-2 gap-3">
              <Input
                id={ADD_IDS.quantityTotal}
                label="Quantity on sale"
                type="number"
                inputMode="numeric"
                min={1}
                required
                className="tabular-nums"
                value={form.quantityTotal}
                error={shown('quantityTotal')}
                onBlur={leave('quantityTotal')}
                onChange={(e) => setForm({ ...form, quantityTotal: e.target.value })}
              />
              <Input
                id={ADD_IDS.maxPerOrder}
                label="Max per order"
                type="number"
                inputMode="numeric"
                min={1}
                className="tabular-nums"
                value={form.maxPerOrder}
                error={shown('maxPerOrder')}
                onBlur={leave('maxPerOrder')}
                onChange={(e) => setForm({ ...form, maxPerOrder: e.target.value })}
              />
            </div>
            <p className="text-caption text-text-muted">
              Quantity is how many you sell, not the venue&apos;s capacity. Max per order is the
              most one buyer can take at once.
            </p>
            {state.kind === 'choose' && (
              /*
                Why Add cannot go ahead yet, in words, with the way forward next to it. The Add
                button is NOT disabled: pressing it says the same thing under the picker and
                puts the cursor there.
              */
              <div
                id={CHOOSE_NOTE_ID}
                className="rounded-md border border-status-info/30 bg-tint-info px-3 py-2 text-caption text-text-primary"
              >
                <p>{state.message}</p>
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  className="mt-2"
                  onClick={() => focusField(ADD_IDS.eventSessionId)}
                >
                  Select {withArticle(words.session)}
                </Button>
              </div>
            )}
            <Button
              type="submit"
              className="w-full"
              icon={Plus}
              loading={add.isPending}
              aria-describedby={state.kind === 'choose' ? CHOOSE_NOTE_ID : undefined}
            >
              Add {ticketLower}
            </Button>
          </form>
        </Card>
      </div>

      <Dialog
        open={editing !== null}
        onClose={() => setEditing(null)}
        title={`Edit ${ticketLower}`}
      >
        <form
          className="space-y-3"
          noValidate
          onSubmit={(e) => {
            e.preventDefault();
            submitEdit();
          }}
        >
          <Input
            id={EDIT_IDS.name}
            label="Name"
            required
            value={editForm.name}
            error={shownEdit('name')}
            onChange={(e) => setEditForm({ ...editForm, name: e.target.value })}
          />
          {!isFree && (
            <Input
              id={EDIT_IDS.priceMajor}
              label={priceLabel(editCurrency, currencySymbol(editCurrency))}
              type="number"
              inputMode="decimal"
              min={0}
              className="tabular-nums"
              value={editForm.priceMajor}
              disabled={priceLocked}
              error={shownEdit('priceMajor')}
              hint={priceLocked ? 'Price is locked because tickets have sold.' : undefined}
              onChange={(e) => setEditForm({ ...editForm, priceMajor: e.target.value })}
            />
          )}
          <Input
            id={EDIT_IDS.quantityTotal}
            label="Quantity on sale"
            type="number"
            inputMode="numeric"
            min={1}
            className="tabular-nums"
            value={editForm.quantityTotal}
            error={shownEdit('quantityTotal')}
            hint={
              editing && committed(editing) > 0
                ? `At least ${committed(editing)}: that many are already sold or held.`
                : undefined
            }
            onChange={(e) => setEditForm({ ...editForm, quantityTotal: e.target.value })}
          />
          <Input
            id={EDIT_IDS.maxPerOrder}
            label="Max per order"
            type="number"
            inputMode="numeric"
            min={1}
            className="tabular-nums"
            value={editForm.maxPerOrder}
            error={shownEdit('maxPerOrder')}
            onChange={(e) => setEditForm({ ...editForm, maxPerOrder: e.target.value })}
          />
          <div className="flex justify-end gap-2 pt-1">
            <Button type="button" variant="outline" onClick={() => setEditing(null)}>
              Cancel
            </Button>
            <Button type="submit" loading={saveEdit.isPending}>
              Save
            </Button>
          </div>
        </form>
      </Dialog>

      <Dialog
        open={deleting !== null}
        onClose={() => setDeleting(null)}
        title={`Delete ${ticketLower}?`}
      >
        <div className="space-y-4">
          <p className="text-[0.9375rem] text-text-secondary">
            Delete <span className="font-medium">{deleting?.name}</span>? This cannot be undone.
          </p>
          <div className="flex justify-end gap-2">
            <Button variant="outline" onClick={() => setDeleting(null)}>
              Cancel
            </Button>
            <Button variant="danger" loading={del.isPending} onClick={() => del.mutate(deleting!)}>
              Delete
            </Button>
          </div>
        </div>
      </Dialog>
    </div>
  );
}
