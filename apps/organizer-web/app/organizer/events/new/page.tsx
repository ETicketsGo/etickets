'use client';

import { useQuery } from '@tanstack/react-query';
import { useRouter, useSearchParams } from 'next/navigation';
import { Suspense, useState } from 'react';
import {
  api,
  Button,
  Card,
  Input,
  Select,
  Textarea,
  Stepper,
  PageHeader,
  Skeleton,
  useToast,
  errorMessage,
  money,
  DateTimeField,
} from '@eticketsgo/web-kit';
import { useOrg } from '@/components/org-context';
import { getTemplate, EVENT_CATEGORIES, isListedCategory } from '@/lib/templates';

const STEPS = ['Basic details', 'Venue', 'Sessions', 'Ticket types', 'Fee handling', 'Review'];
const FEE_MODES = [
  { value: 'CUSTOMER_PAYS', label: 'Customer pays fees' },
  { value: 'ORGANIZER_PAYS', label: 'Organizer absorbs fees' },
  { value: 'SHARED', label: 'Shared 50/50' },
];

interface SessionDraft {
  startsAt: string;
  endsAt: string;
}
interface TicketDraft {
  sessionIndex: number;
  name: string;
  priceRupees: string;
  quantityTotal: string;
  maxPerOrder: string;
}

function NewEventWizard() {
  const { activeOrg } = useOrg();
  const router = useRouter();
  const toast = useToast();
  // Optional starter template deep-linked from onboarding (?template=concert, …).
  // Purely seeds initial field values — the wizard's own logic is unchanged.
  const searchParams = useSearchParams();
  const template = getTemplate(searchParams.get('template'));
  const [step, setStep] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);

  const venuesQ = useQuery({
    queryKey: ['venues', activeOrg.id],
    queryFn: () => api.venues.list(activeOrg.id),
  });

  const [basics, setBasics] = useState({
    title: template?.suggestedTitle ?? '',
    category: template?.category ?? '',
    description: template?.description ?? '',
    refundPolicy: '',
  });
  /*
    Whether the category is being picked or typed.

    A template can seed a category that is not on the list, so this is derived from the seed
    rather than defaulting to the dropdown — otherwise the wizard would open showing a select
    whose value it cannot display, silently losing what the template chose.
  */
  const [categoryMode, setCategoryMode] = useState<'list' | 'other'>(
    template && !isListedCategory(template.category) ? 'other' : 'list',
  );
  /*
    Free events, declared here rather than inferred from the prices on step 4.

    Deriving it would make the event flip between free and paid as somebody edited a number,
    and free is not a price — it changes what the platform DOES. No payment provider is
    called, no booking fee and no platform share are taken, and the buyer never sees a
    checkout. Everything after the money is unchanged: tickets, QR codes, cancellation.
  */
  const [isFree, setIsFree] = useState(false);
  const [venueMode, setVenueMode] = useState<'existing' | 'new'>('existing');
  const [venueId, setVenueId] = useState('');
  const [newVenue, setNewVenue] = useState({ name: '', city: '', country: 'India', capacity: '' });
  const [feeMode, setFeeMode] = useState('CUSTOMER_PAYS');
  const [sessions, setSessions] = useState<SessionDraft[]>([{ startsAt: '', endsAt: '' }]);
  const [tickets, setTickets] = useState<TicketDraft[]>([
    {
      sessionIndex: 0,
      name: 'General',
      priceRupees: '499',
      quantityTotal: '100',
      maxPerOrder: '6',
    },
  ]);

  const validateStep = (): Record<string, string> => {
    const e: Record<string, string> = {};
    if (step === 0) {
      if (basics.title.trim().length < 3) e.title = 'Title must be at least 3 characters.';
      if (!basics.category.trim()) e.category = 'Category is required.';
    }
    if (step === 1) {
      if (venueMode === 'existing' && !venueId) e.venueId = 'Select a venue.';
      if (venueMode === 'new') {
        if (!newVenue.name.trim()) e.venueName = 'Venue name is required.';
        if (!newVenue.city.trim()) e.venueCity = 'City is required.';
      }
    }
    if (step === 2) {
      if (sessions.length === 0) e.form = 'Add at least one session.';
      sessions.forEach((s, i) => {
        if (!s.startsAt) e[`s${i}Start`] = 'Start time is required.';
        if (!s.endsAt) e[`s${i}End`] = 'End time is required.';
        if (s.startsAt && s.endsAt && new Date(s.endsAt) <= new Date(s.startsAt))
          e[`s${i}End`] = 'End must be after start.';
      });
    }
    if (step === 3) {
      if (tickets.length === 0) e.form = 'Add at least one ticket type.';
      tickets.forEach((t, i) => {
        if (!t.name.trim()) e[`t${i}Name`] = 'Name is required.';
        if (
          !isFree &&
          (t.priceRupees === '' ||
            !Number.isFinite(Number(t.priceRupees)) ||
            Number(t.priceRupees) < 0)
        )
          e[`t${i}Price`] = 'Enter a valid price (0 or more).';
        if (Number(t.quantityTotal) < 1) e[`t${i}Qty`] = 'Quantity must be at least 1.';
      });
    }
    return e;
  };

  const next = () => {
    const errs = validateStep();
    setFieldErrors(errs);
    if (Object.keys(errs).length > 0) {
      setError(errs.form ?? null);
      return;
    }
    setError(null);
    setStep((s) => Math.min(s + 1, STEPS.length - 1));
  };
  const back = () => {
    setError(null);
    setFieldErrors({});
    setStep((s) => Math.max(s - 1, 0));
  };

  const commit = async (submitForReview: boolean) => {
    setBusy(true);
    setError(null);
    try {
      let finalVenueId = venueId;
      if (venueMode === 'new') {
        const created = await api.venues.create({
          organizationId: activeOrg.id,
          name: newVenue.name,
          city: newVenue.city,
          country: newVenue.country,
          capacity: newVenue.capacity ? Number(newVenue.capacity) : undefined,
        });
        finalVenueId = created.id;
      }
      const event = await api.events.create({
        organizationId: activeOrg.id,
        venueId: finalVenueId,
        title: basics.title,
        category: basics.category,
        description: basics.description || undefined,
        refundPolicy: basics.refundPolicy || undefined,
        feeMode,
        isFree,
      });
      const sessionIds: string[] = [];
      for (const s of sessions) {
        const created = await api.events.addSession(event.id, {
          startsAt: new Date(s.startsAt).toISOString(),
          endsAt: new Date(s.endsAt).toISOString(),
        });
        sessionIds.push(created.id);
      }
      for (const t of tickets) {
        await api.events.addTicketType({
          eventSessionId: sessionIds[t.sessionIndex] ?? sessionIds[0],
          name: t.name,
          // Zero regardless of what the price box happens to hold: a free event's ticket
          // types must all be zero and the API refuses anything else, so sending the stale
          // contents of a disabled field would fail the whole creation with a confusing error.
          priceMinor: isFree ? 0 : Math.round(Number(t.priceRupees) * 100),
          quantityTotal: Number(t.quantityTotal),
          maxPerOrder: Number(t.maxPerOrder) || 10,
        });
      }
      if (submitForReview) await api.events.submit(event.id);
      toast.push(
        submitForReview ? 'Event submitted for review.' : 'Draft event created.',
        'success',
      );
      router.push(`/organizer/events/${event.id}`);
    } catch (err) {
      setError(errorMessage(err));
      setBusy(false);
    }
  };

  return (
    <div className="mx-auto max-w-2xl space-y-6">
      <PageHeader
        title="Create event"
        breadcrumbs={[{ label: 'Events', href: '/organizer/events' }, { label: 'New' }]}
      />

      <Stepper steps={STEPS} current={step} />

      <Card>
        {step === 0 && (
          <div className="space-y-4">
            <Input
              id="title"
              label="Event title"
              autoFocus
              value={basics.title}
              onChange={(e) => setBasics({ ...basics, title: e.target.value })}
              error={fieldErrors.title}
            />
            <Select
              id="category"
              label="Category"
              value={categoryMode === 'other' ? '__other' : basics.category}
              error={categoryMode === 'list' ? fieldErrors.category : undefined}
              onChange={(e) => {
                if (e.target.value === '__other') {
                  setCategoryMode('other');
                  setBasics((b) => ({ ...b, category: '' }));
                } else {
                  setCategoryMode('list');
                  setBasics((b) => ({ ...b, category: e.target.value }));
                }
              }}
            >
              <option value="">Select a category…</option>
              {EVENT_CATEGORIES.map((c) => (
                <option key={c} value={c}>
                  {c}
                </option>
              ))}
              <option value="__other">Something else…</option>
            </Select>
            {categoryMode === 'other' && (
              <Input
                id="category-other"
                label="Your category"
                autoFocus
                placeholder="e.g. Poetry reading"
                value={basics.category}
                onChange={(e) => setBasics({ ...basics, category: e.target.value })}
                error={fieldErrors.category}
              />
            )}
            <Textarea
              id="desc"
              label="Description"
              rows={4}
              value={basics.description}
              onChange={(e) => setBasics({ ...basics, description: e.target.value })}
            />
            <Textarea
              id="refund"
              label="Refund policy"
              rows={2}
              value={basics.refundPolicy}
              onChange={(e) => setBasics({ ...basics, refundPolicy: e.target.value })}
            />
            <label className="flex items-start gap-3 rounded-md border border-border p-3">
              <input
                id="is-free"
                type="checkbox"
                className="mt-1 h-4 w-4"
                checked={isFree}
                onChange={(e) => setIsFree(e.target.checked)}
              />
              <span className="text-sm">
                <span className="font-medium">This is a free event</span>
                <span className="mt-1 block text-text-muted">
                  Nobody is charged, so there is no checkout, no booking fee and no platform share.
                  Attendees still book, get tickets and QR codes, and can cancel.
                </span>
              </span>
            </label>
          </div>
        )}

        {step === 1 && (
          <div className="space-y-4">
            <div className="flex gap-2">
              <Button
                variant={venueMode === 'existing' ? 'primary' : 'outline'}
                onClick={() => setVenueMode('existing')}
              >
                Existing venue
              </Button>
              <Button
                variant={venueMode === 'new' ? 'primary' : 'outline'}
                onClick={() => setVenueMode('new')}
              >
                New venue
              </Button>
            </div>
            {venueMode === 'existing' ? (
              <Select
                id="venue"
                label="Venue"
                value={venueId}
                onChange={(e) => setVenueId(e.target.value)}
                error={fieldErrors.venueId}
              >
                <option value="">Select a venue…</option>
                {(venuesQ.data ?? []).map((v) => (
                  <option key={v.id} value={v.id}>
                    {v.name} — {v.city}
                  </option>
                ))}
              </Select>
            ) : (
              <div className="grid gap-3 sm:grid-cols-2">
                <Input
                  id="vname"
                  label="Venue name"
                  value={newVenue.name}
                  onChange={(e) => setNewVenue({ ...newVenue, name: e.target.value })}
                  error={fieldErrors.venueName}
                />
                <Input
                  id="vcity"
                  label="City"
                  value={newVenue.city}
                  onChange={(e) => setNewVenue({ ...newVenue, city: e.target.value })}
                  error={fieldErrors.venueCity}
                />
                <Input
                  id="vcountry"
                  label="Country"
                  value={newVenue.country}
                  onChange={(e) => setNewVenue({ ...newVenue, country: e.target.value })}
                />
                <Input
                  id="vcap"
                  label="Capacity"
                  type="number"
                  value={newVenue.capacity}
                  onChange={(e) => setNewVenue({ ...newVenue, capacity: e.target.value })}
                />
              </div>
            )}
          </div>
        )}

        {step === 2 && (
          <div className="space-y-4">
            {sessions.map((s, i) => (
              <div
                key={i}
                className="grid gap-3 rounded-md border border-border p-3 sm:grid-cols-2"
              >
                <DateTimeField
                  id={`ss${i}`}
                  label="Starts at"
                  value={s.startsAt}
                  onChange={(v) =>
                    setSessions(sessions.map((x, j) => (j === i ? { ...x, startsAt: v } : x)))
                  }
                  error={fieldErrors[`s${i}Start`]}
                />
                <DateTimeField
                  id={`se${i}`}
                  label="Ends at"
                  value={s.endsAt}
                  // Anchored to the start, so the shortcuts read "+2h" instead of asking
                  // the organizer to work out what two hours after 7:30pm is.
                  relativeTo={s.startsAt}
                  min={s.startsAt}
                  onChange={(v) =>
                    setSessions(sessions.map((x, j) => (j === i ? { ...x, endsAt: v } : x)))
                  }
                  error={fieldErrors[`s${i}End`]}
                />
                {sessions.length > 1 && (
                  <Button
                    variant="ghost"
                    size="sm"
                    className="justify-self-start text-status-error"
                    onClick={() => setSessions(sessions.filter((_, j) => j !== i))}
                  >
                    Remove session
                  </Button>
                )}
              </div>
            ))}
            <Button
              variant="outline"
              onClick={() => setSessions([...sessions, { startsAt: '', endsAt: '' }])}
            >
              + Add session
            </Button>
          </div>
        )}

        {step === 3 && (
          <div className="space-y-4">
            {tickets.map((t, i) => (
              <div
                key={i}
                className="grid gap-3 rounded-md border border-border p-3 sm:grid-cols-2"
              >
                <Input
                  id={`tn${i}`}
                  label="Name"
                  value={t.name}
                  onChange={(e) =>
                    setTickets(
                      tickets.map((x, j) => (j === i ? { ...x, name: e.target.value } : x)),
                    )
                  }
                  error={fieldErrors[`t${i}Name`]}
                />
                <Select
                  id={`tsi${i}`}
                  label="Session"
                  value={t.sessionIndex}
                  onChange={(e) =>
                    setTickets(
                      tickets.map((x, j) =>
                        j === i ? { ...x, sessionIndex: Number(e.target.value) } : x,
                      ),
                    )
                  }
                >
                  {/*
                    Named by when it starts, not by its index.

                    "Session 1" identifies nothing — with three showings on one day an
                    organizer cannot tell which is which, and it reads as though only one
                    session exists. The date is the thing they actually chose.
                  */}
                  {sessions.map((sess, si) => (
                    <option key={si} value={si}>
                      {sess.startsAt
                        ? new Date(sess.startsAt).toLocaleString('en-IN', {
                            day: 'numeric',
                            month: 'short',
                            hour: 'numeric',
                            minute: '2-digit',
                          })
                        : `Session ${si + 1} — no time set`}
                    </option>
                  ))}
                </Select>
                {/*
                  On a free event the price is not editable, and says why.

                  Disabling it rather than hiding it keeps the row's shape and answers the
                  obvious question — "where did the price go?" — in the place it was asked.
                */}
                <Input
                  id={`tp${i}`}
                  label="Price (₹)"
                  type="number"
                  value={isFree ? '0' : t.priceRupees}
                  disabled={isFree}
                  hint={isFree ? 'Free event — attendees pay nothing.' : undefined}
                  error={fieldErrors[`t${i}Price`]}
                  onChange={(e) =>
                    setTickets(
                      tickets.map((x, j) => (j === i ? { ...x, priceRupees: e.target.value } : x)),
                    )
                  }
                />
                <Input
                  id={`tq${i}`}
                  label="Quantity"
                  type="number"
                  value={t.quantityTotal}
                  onChange={(e) =>
                    setTickets(
                      tickets.map((x, j) =>
                        j === i ? { ...x, quantityTotal: e.target.value } : x,
                      ),
                    )
                  }
                  error={fieldErrors[`t${i}Qty`]}
                />
                <Input
                  id={`tm${i}`}
                  label="Max per order"
                  type="number"
                  value={t.maxPerOrder}
                  onChange={(e) =>
                    setTickets(
                      tickets.map((x, j) => (j === i ? { ...x, maxPerOrder: e.target.value } : x)),
                    )
                  }
                />
                {tickets.length > 1 && (
                  <Button
                    variant="ghost"
                    size="sm"
                    className="justify-self-start self-end text-status-error"
                    onClick={() => setTickets(tickets.filter((_, j) => j !== i))}
                  >
                    Remove
                  </Button>
                )}
              </div>
            ))}
            <Button
              variant="outline"
              onClick={() =>
                setTickets([
                  ...tickets,
                  {
                    sessionIndex: 0,
                    name: '',
                    priceRupees: '',
                    quantityTotal: '',
                    maxPerOrder: '6',
                  },
                ])
              }
            >
              + Add ticket type
            </Button>
          </div>
        )}

        {step === 4 &&
          (isFree ? (
            /*
              There are no fees to hand to anybody, so asking who pays them would be a
              question with no true answer. The setting is still stored as it was — it simply
              never applies while the event is free.
            */
            <div className="rounded-md border border-border p-4 text-sm">
              <p className="font-medium">No fees on a free event</p>
              <p className="mt-1 text-text-muted">
                Attendees pay nothing, so there is no booking fee, no payment fee and no platform
                share to divide.
              </p>
            </div>
          ) : (
            <Select
              id="feeMode"
              label="Fee handling"
              value={feeMode}
              onChange={(e) => setFeeMode(e.target.value)}
            >
              {FEE_MODES.map((f) => (
                <option key={f.value} value={f.value}>
                  {f.label}
                </option>
              ))}
            </Select>
          ))}

        {step === 5 && (
          <div className="space-y-3 text-sm">
            <Row label="Title" value={basics.title} />
            <Row label="Category" value={basics.category} />
            <Row label="Admission" value={isFree ? 'Free — no payment taken' : 'Paid'} />
            <Row
              label="Venue"
              value={
                venueMode === 'existing'
                  ? (venuesQ.data?.find((v) => v.id === venueId)?.name ?? '—')
                  : `${newVenue.name}, ${newVenue.city} (new)`
              }
            />
            {!isFree && (
              <Row
                label="Fee handling"
                value={FEE_MODES.find((f) => f.value === feeMode)?.label ?? feeMode}
              />
            )}
            <Row label="Sessions" value={`${sessions.length}`} />
            <Row
              label="Ticket types"
              value={tickets
                .map(
                  (t) =>
                    `${t.name} (${isFree ? 'Free' : money(Math.round(Number(t.priceRupees) * 100))} × ${t.quantityTotal})`,
                )
                .join(', ')}
            />
          </div>
        )}

        {error && (
          <p role="alert" className="mt-4 text-sm text-status-error">
            {error}
          </p>
        )}

        <div className="mt-6 flex justify-between">
          <Button variant="outline" onClick={back} disabled={step === 0 || busy}>
            Back
          </Button>
          {step < STEPS.length - 1 ? (
            <Button onClick={next}>Next</Button>
          ) : (
            <div className="flex gap-2">
              <Button variant="outline" loading={busy} onClick={() => commit(false)}>
                Save draft
              </Button>
              <Button loading={busy} onClick={() => commit(true)}>
                Submit for approval
              </Button>
            </div>
          )}
        </div>
      </Card>
    </div>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex justify-between gap-4 border-b border-border pb-2">
      <span className="text-text-muted">{label}</span>
      <span className="text-right font-medium text-text-primary">{value || '—'}</span>
    </div>
  );
}

// useSearchParams() requires a Suspense boundary during static generation.
export default function NewEventPage() {
  return (
    <Suspense fallback={<Skeleton className="mx-auto h-96 max-w-2xl" />}>
      <NewEventWizard />
    </Suspense>
  );
}
