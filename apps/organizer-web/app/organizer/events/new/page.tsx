'use client';

import { useQuery } from '@tanstack/react-query';
import { useRouter, useSearchParams } from 'next/navigation';
import { Suspense, useEffect, useRef, useState } from 'react';
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
  currencyForCountry,
  DateTimeField,
  LocationFields,
  defaultLocation,
  type LocationValue,
} from '@eticketsgo/web-kit';
import { useOrg } from '@/components/org-context';
import { getTemplate, EVENT_CATEGORIES, isListedCategory } from '@/lib/templates';
import { clearEventDraft, draftAge, readEventDraft, saveEventDraft } from '@/lib/event-draft';

const STEPS = ['Basic details', 'Venue', 'Sessions', 'Ticket types', 'Fee handling', 'Review'];
const FEE_MODES = [
  { value: 'CUSTOMER_PAYS', label: 'Customer pays fees' },
  { value: 'ORGANIZER_PAYS', label: 'Organizer absorbs fees' },
  { value: 'SHARED', label: 'Shared 50/50' },
];

interface SessionDraft {
  startsAt: string;
  endsAt: string;
  /**
   * The room this session plays in, or '' for general admission.
   *
   * Per SESSION rather than per event, because it genuinely varies: a run of shows can move
   * from the main auditorium to the studio, and the same event is reserved seating in one
   * and general admission in the other.
   */
  screenId: string;
}
interface TicketDraft {
  sessionIndex: number;
  name: string;
  /** Entered in MAJOR units of the venue's currency — rupees in India, dollars in the US. */
  priceMajor: string;
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
  /*
    The rooms with a published seat map, fetched up front so step 3 can offer reserved
    seating without a spinner in the middle of the form.

    Answered by the server rather than assembled here, because "which rooms can this be
    seated in" is the same rule the create call enforces, and two copies of it drift. When
    the list is empty the step says so plainly instead of hiding the choice — an organizer
    looking for a seat map needs to know it is missing, not that the feature is.
  */
  const roomsQ = useQuery({
    queryKey: ['seating-rooms', activeOrg.id],
    queryFn: () => api.events.seatingRooms(activeOrg.id),
  });

  const [basics, setBasics] = useState({
    title: template?.suggestedTitle ?? '',
    category: template?.category ?? '',
    description: template?.description ?? '',
    refundPolicy: '',
    /* The platform's existing behaviour, now stated rather than assumed. */
    refundsEnabled: true,
    refundCutoffHours: '48',
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
  const [newVenue, setNewVenue] = useState({ name: '', city: '', capacity: '' });
  // Same three interdependent answers as the venues page, from the same component — a venue
  // created mid-wizard is a venue, and it was previously created without a state or a clock.
  const [newVenueWhere, setNewVenueWhere] = useState<LocationValue>(defaultLocation);
  const [feeMode, setFeeMode] = useState('CUSTOMER_PAYS');

  /*
    The currency this event will sell in, and the symbol on the price field.

    Currency follows the VENUE on this platform — where the event is held decides what the
    buyer is charged and which tax rules apply. The price box said "Price (₹)" whatever the
    venue, so an organizer entering 499 for a show in Boise was told they were typing rupees
    while the platform priced it in dollars. The number was never converted; only the label
    lied, which is the worst version of that bug because everything downstream is consistent
    and the organizer has no way to notice.
  */
  const chosenVenue = venuesQ.data?.find((v) => v.id === venueId);
  /*
    What the room holds, if anybody has said.

    Kept separate from the ticket quantities on purpose: capacity is a fact about the
    building and quantity is a decision about this event. They are not the same number and
    the wizard asks for both, one step apart, which is why they get mistaken for each other.
  */
  const venueCapacity =
    venueMode === 'new'
      ? newVenue.capacity
        ? Number(newVenue.capacity)
        : null
      : (chosenVenue?.capacity ?? null);
  const eventCountry = venueMode === 'new' ? newVenueWhere.country : chosenVenue?.country;
  const eventCurrency = currencyForCountry(eventCountry) ?? 'INR';
  /* Symbol only — the field holds a plain number, so a formatted amount would be misleading. */
  const currencySymbol =
    new Intl.NumberFormat(undefined, { style: 'currency', currency: eventCurrency })
      .formatToParts(0)
      .find((p) => p.type === 'currency')?.value ?? eventCurrency;
  const [sessions, setSessions] = useState<SessionDraft[]>([
    { startsAt: '', endsAt: '', screenId: '' },
  ]);
  const [tickets, setTickets] = useState<TicketDraft[]>([
    {
      sessionIndex: 0,
      name: 'General',
      priceMajor: '499',
      quantityTotal: '100',
      maxPerOrder: '6',
    },
  ]);

  /*
    ── THE DRAFT SURVIVES LEAVING THIS PAGE ──────────────────────────────────────────
    The only route to a seat map is another screen, and this wizard held everything in
    component state — so the product sent an organizer away to create a room and then threw
    away everything they had typed. Reported exactly that way, and the second half of the
    complaint ("it is still in rooms section") is the same defect: nothing brought them back.

    Saved on every change and restored on return, with the organizer told it happened. Cleared
    the moment a real event exists, so a finished wizard never offers to restore itself.
  */
  const draftState = {
    step,
    basics,
    categoryMode,
    isFree,
    venueMode,
    venueId,
    newVenue,
    newVenueWhere,
    feeMode,
    sessions,
    tickets,
  };
  type DraftState = typeof draftState;
  const [restoredAt, setRestoredAt] = useState<number | null>(null);
  /* Set once a draft has been considered, so the first render cannot save over it. */
  const hydrated = useRef(false);

  useEffect(() => {
    const found = readEventDraft<DraftState>(activeOrg.id);
    hydrated.current = true;
    if (!found) return;
    const d = found.data;
    setStep(d.step ?? 0);
    setBasics(d.basics);
    setCategoryMode(d.categoryMode);
    setIsFree(d.isFree);
    setVenueMode(d.venueMode);
    setVenueId(d.venueId);
    setNewVenue(d.newVenue);
    setNewVenueWhere(d.newVenueWhere);
    setFeeMode(d.feeMode);
    setSessions(d.sessions);
    setTickets(d.tickets);
    setRestoredAt(found.savedAt);
    // Runs for the organization, not for the draft: re-reading on every keystroke would fight
    // the person typing.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeOrg.id]);

  useEffect(() => {
    // Never before the restore has had its turn, or an empty form overwrites a real draft.
    if (!hydrated.current) return;
    saveEventDraft(activeOrg.id, draftState);
  });

  /*
    Sessions that still need ticket types typed by hand.

    A seated session gets one ticket type per seat category the moment it is created, priced
    from the category, because a seat's price is a fact about where it is in the room. Asking
    the organizer to invent ticket types for it as well would produce a second, conflicting
    set of prices — and the room's would win at the point of sale, silently.
  */
  const gaSessions = sessions.map((s, i) => ({ s, i })).filter(({ s }) => !s.screenId);
  const allSeated = sessions.length > 0 && gaSessions.length === 0;
  const roomById = (screenId: string) => roomsQ.data?.find((r) => r.id === screenId);

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
    if (step === 3 && !allSeated) {
      // Only the tickets that will actually be sent are judged. One left pointing at a
      // session that has since been given a room is dropped on submit, so blocking the
      // organizer on it would be refusing to accept a form because of a field they cannot see.
      const sent = tickets.filter((t) => !sessions[t.sessionIndex]?.screenId);
      if (sent.length === 0) e.form = 'Add at least one ticket type.';
      tickets.forEach((t, i) => {
        if (sessions[t.sessionIndex]?.screenId) return;
        if (!t.name.trim()) e[`t${i}Name`] = 'Name is required.';
        if (
          !isFree &&
          (t.priceMajor === '' ||
            !Number.isFinite(Number(t.priceMajor)) ||
            Number(t.priceMajor) < 0)
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
          country: newVenueWhere.country,
          region: newVenueWhere.region,
          timezone: newVenueWhere.timezone || undefined,
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
        refundsEnabled: basics.refundsEnabled,
        refundCutoffHours: Number(basics.refundCutoffHours),
        feeMode,
        isFree,
      });
      const sessionIds: string[] = [];
      for (const s of sessions) {
        const created = await api.events.addSession(event.id, {
          startsAt: new Date(s.startsAt).toISOString(),
          endsAt: new Date(s.endsAt).toISOString(),
          // Omitted rather than sent empty: '' is a room id that does not exist, and the
          // request would be refused instead of understood as "no room".
          ...(s.screenId ? { screenId: s.screenId } : {}),
        });
        sessionIds.push(created.id);
      }
      /*
        Seated sessions are skipped. Their ticket types already exist — created from the
        room's seat categories — and adding more here would put two competing prices on the
        same night.
      */
      for (const t of tickets.filter((x) => !sessions[x.sessionIndex]?.screenId)) {
        await api.events.addTicketType({
          eventSessionId: sessionIds[t.sessionIndex] ?? sessionIds[0],
          name: t.name,
          // Zero regardless of what the price box happens to hold: a free event's ticket
          // types must all be zero and the API refuses anything else, so sending the stale
          // contents of a disabled field would fail the whole creation with a confusing error.
          priceMinor: isFree ? 0 : Math.round(Number(t.priceMajor) * 100),
          quantityTotal: Number(t.quantityTotal),
          maxPerOrder: Number(t.maxPerOrder) || 10,
        });
      }
      if (submitForReview) await api.events.submit(event.id);
      toast.push(
        submitForReview ? 'Event submitted for review.' : 'Draft event created.',
        'success',
      );
      // The event exists; the draft is now a duplicate of something real.
      clearEventDraft();
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

      {/*
        Say that the form was refilled.

        Silently restoring somebody's work is nearly as disorienting as losing it — they came
        back expecting a blank wizard and found one with answers in it. Saying where those
        came from, and offering to throw them away, turns a surprise into a choice.
      */}
      {restoredAt !== null && (
        <div className="flex flex-wrap items-center justify-between gap-3 rounded-md border border-border bg-background-subtle px-4 py-3">
          <p className="text-caption text-text-secondary">
            Picked up where you left off — saved {draftAge(restoredAt)}.
          </p>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => {
              clearEventDraft();
              window.location.reload();
            }}
          >
            Start over
          </Button>
        </div>
      )}

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
            {/*
              ── THE REFUND RULE, THEN THE PROSE ───────────────────────────────────────
              This was one free-text box, and nothing read it. `refundsEnabled` and
              `refundCutoffHours` have been on the event and enforced by the refund path all
              along; nothing wrote them. So an organizer could type "no refunds" while the
              platform went on offering them for 48 hours — the buyer reading the prose and
              the software deciding the outcome were two unrelated things.

              The two controls that DECIDE come first, and the box that describes comes after,
              labelled as an addition rather than the rule.
            */}
            <fieldset className="space-y-3 rounded-md border border-border p-3">
              <legend className="px-1 text-caption font-medium text-text-secondary">Refunds</legend>
              <label className="flex items-start gap-3">
                <input
                  id="refunds-enabled"
                  type="checkbox"
                  className="mt-1 h-4 w-4"
                  checked={basics.refundsEnabled}
                  onChange={(e) => setBasics({ ...basics, refundsEnabled: e.target.checked })}
                />
                <span className="text-sm">
                  <span className="font-medium">Attendees can request a refund</span>
                  <span className="mt-1 block text-text-muted">
                    Turn this off and the refund button never appears. Your team can still refund
                    someone by hand.
                  </span>
                </span>
              </label>
              {basics.refundsEnabled && (
                <Select
                  id="refund-cutoff"
                  label="Refunds close"
                  value={basics.refundCutoffHours}
                  hint="Measured back from the session start. After this point the button is gone."
                  onChange={(e) => setBasics({ ...basics, refundCutoffHours: e.target.value })}
                >
                  <option value="0">Right up to start time</option>
                  <option value="2">2 hours before</option>
                  <option value="24">24 hours before</option>
                  <option value="48">48 hours before</option>
                  <option value="72">3 days before</option>
                  <option value="168">7 days before</option>
                  <option value="336">14 days before</option>
                </Select>
              )}
              <Textarea
                id="refund"
                label="Conditions (optional)"
                rows={2}
                placeholder="e.g. Refunds are less a ₹50 handling charge. Rain does not cancel."
                hint="Shown to buyers alongside the rule above. Anything here is words, not behaviour — the two settings above are what the platform enforces."
                value={basics.refundPolicy}
                onChange={(e) => setBasics({ ...basics, refundPolicy: e.target.value })}
              />
            </fieldset>
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
              <div className="space-y-3">
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
                    id="vcap"
                    label="Venue capacity"
                    type="number"
                    value={newVenue.capacity}
                    /*
                      Named and explained, because it was read as "how many tickets am I
                      selling" — which is the NEXT step's question and a different number.
                      This one is a fact about the building; that one is a decision about
                      this event.
                    */
                    hint="How many people the room holds. Each ticket type sets its own quantity — we warn you if they add up to more than this."
                    onChange={(e) => setNewVenue({ ...newVenue, capacity: e.target.value })}
                  />
                </div>
                <LocationFields
                  idPrefix="newvenue"
                  value={newVenueWhere}
                  onChange={setNewVenueWhere}
                  countryHint="Sets the currency you sell in and the tax rules that apply."
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
                {/*
                  Where this session sits, and it is the only thing that decides whether the
                  event sells named seats. Spanning both columns because the room's name and
                  its seat count are long, and the explanation underneath is the part that
                  answers "which should I pick?".
                */}
                <div className="sm:col-span-2">
                  <Select
                    id={`sr${i}`}
                    label="Seating"
                    value={s.screenId}
                    disabled={roomsQ.isLoading}
                    onChange={(e) => {
                      const screenId = e.target.value;
                      const updated = sessions.map((x, j) => (j === i ? { ...x, screenId } : x));
                      setSessions(updated);
                      /*
                        Move any ticket types that were pointing at this session.

                        Without this they keep an index whose session is no longer offered in
                        the dropdown on the next step: the control renders blank, the row
                        looks broken, and the draft is silently dropped on submit. Sending
                        them to the first session that still needs ticket types is visible
                        and reversible; leaving them dangling is neither.
                      */
                      if (!screenId) return;
                      const fallback = updated.findIndex((x) => !x.screenId);
                      if (fallback === -1) return;
                      setTickets((prev) =>
                        prev.map((t) =>
                          t.sessionIndex === i ? { ...t, sessionIndex: fallback } : t,
                        ),
                      );
                    }}
                  >
                    <option value="">General admission — no seat map</option>
                    {(roomsQ.data ?? []).map((r) => (
                      <option key={r.id} value={r.id}>
                        {r.venueName} · {r.name} ({r.sellableSeats} seats)
                      </option>
                    ))}
                  </Select>
                  {/*
                    ── WHY THIS DROPDOWN OFTEN HAS ONE OPTION ──────────────────────────
                    It lists rooms that have a PUBLISHED seat map, and a new organization has
                    none — so it shows "General admission" alone and reads as broken rather
                    than as empty.

                    The hint explaining that used to end "— Venues → Rooms", which is not
                    where rooms are: the section is called "Rooms & seat maps" and lives at
                    its own place in the sidebar. Sending somebody to a menu path that does
                    not exist is worse than saying nothing, and this product has already lost
                    the seat-map feature once to exactly that kind of misdirection. It is now
                    a link, so it is one click rather than a hunt.
                  */}
                  <p className="mt-1.5 text-caption text-text-muted">
                    {roomsQ.isError ? (
                      "We couldn't load your rooms, so only general admission is available here."
                    ) : s.screenId ? (
                      `Buyers pick a named seat. Ticket types are created from this room's seat categories and priced from them, so you won't need to add any on the next step.`
                    ) : roomsQ.data?.length === 0 ? (
                      <>
                        Buyers choose how many tickets they want — this is the only option because
                        none of your rooms has a published seat map yet. To sell numbered seats,
                        draw one under{' '}
                        {/*
                          Opened in a NEW TAB, deliberately.

                          Drawing a seat map is a prerequisite living on another screen, and
                          sending somebody there mid-wizard is what lost their work in the first
                          place. The draft survives either way now, but not leaving at all beats
                          leaving and being restored: the half-filled form stays on screen behind
                          them, exactly where they left it.
                        */}
                        <a
                          href="/organizer/cinemas"
                          target="_blank"
                          rel="noopener noreferrer"
                          className="font-medium text-action-primary underline underline-offset-2"
                        >
                          Rooms &amp; seat maps
                        </a>{' '}
                        — it opens in a new tab, and what you have typed here is saved either way.
                      </>
                    ) : (
                      'Buyers choose how many tickets they want. Pick a room to sell numbered seats instead.'
                    )}
                  </p>
                </div>
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
              onClick={() => setSessions([...sessions, { startsAt: '', endsAt: '', screenId: '' }])}
            >
              + Add session
            </Button>
          </div>
        )}

        {step === 3 && allSeated && (
          /*
            Nothing to ask for. Every session is in a room, so the ticket types already exist
            — one per seat category, priced from the category. Showing an empty form the
            organizer must fill in and that would then be discarded is worse than saying so.
          */
          <div className="rounded-md border border-border p-4 text-sm">
            <p className="font-medium">Ticket types come from the seat map</p>
            <p className="mt-1 text-text-muted">
              {sessions.length === 1 ? 'This session is' : 'Every session is'} in a room with
              assigned seating, so a ticket type is created for each seat category and priced from
              it. You can adjust prices per session afterwards from the event&rsquo;s pricing page.
            </p>
          </div>
        )}

        {step === 3 && !allSeated && (
          <div className="space-y-4">
            {/*
              ── MORE TICKETS THAN THE ROOM HOLDS ──────────────────────────────────────
              A warning, not a block. Overselling a stated capacity is usually a mistake and
              occasionally deliberate — standing room, a capacity nobody updated, two
              sessions sharing one venue record — and the platform does not know which. What
              it can do is notice, say so with both numbers, and let the organizer decide.

              Counted per SESSION, because that is what fills the room. Summing every ticket
              type across a three-night run and comparing that to one night's capacity would
              cry wolf on the most ordinary setup there is.
            */}
            {venueCapacity !== null &&
              gaSessions.map(({ i }) => {
                const forSession = tickets
                  .filter((t) => t.sessionIndex === i)
                  .reduce((n, t) => n + (Number(t.quantityTotal) || 0), 0);
                if (forSession <= venueCapacity) return null;
                return (
                  <p
                    key={`cap-${i}`}
                    role="status"
                    className="rounded-md border border-status-warning/40 bg-tint-warning px-3 py-2 text-caption text-status-warning"
                  >
                    Session {i + 1} has {forSession.toLocaleString()} tickets on sale but the venue
                    holds {venueCapacity.toLocaleString()}. Capacity is what the room seats;
                    quantity is what you put on sale — change one of them if that is not deliberate.
                  </p>
                );
              })}
            {sessions.some((x) => x.screenId) && (
              // Otherwise the shorter list of sessions in the dropdown below reads as a bug.
              <p className="text-caption text-text-muted">
                Sessions with assigned seating are not listed below — their ticket types come from
                the room&rsquo;s seat categories.
              </p>
            )}
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
                  {gaSessions.map(({ s: sess, i: si }) => (
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
                  label={`Price (${currencySymbol})`}
                  type="number"
                  value={isFree ? '0' : t.priceMajor}
                  disabled={isFree}
                  hint={isFree ? 'Free event — attendees pay nothing.' : undefined}
                  error={fieldErrors[`t${i}Price`]}
                  onChange={(e) =>
                    setTickets(
                      tickets.map((x, j) => (j === i ? { ...x, priceMajor: e.target.value } : x)),
                    )
                  }
                />
                <Input
                  id={`tq${i}`}
                  label="Quantity on sale"
                  type="number"
                  value={t.quantityTotal}
                  hint="How many of THIS ticket type are for sale. Not the venue's capacity."
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
                    // Not 0: session 0 may be seated, and a row bound to it is discarded.
                    sessionIndex: gaSessions[0]?.i ?? 0,
                    name: '',
                    priceMajor: '',
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
            {/*
              Seating is named here rather than counted. "2 seated" would not tell the
              organizer WHICH room, and booking a run of shows into the wrong auditorium is
              the mistake this page exists to catch — after the event is created the seats
              are already written and the session has to be removed to change it.
            */}
            <Row
              label="Seating"
              value={
                allSeated && sessions.length === 1
                  ? `Assigned seats — ${roomById(sessions[0].screenId)?.name ?? 'selected room'}`
                  : sessions.every((x) => !x.screenId)
                    ? 'General admission'
                    : sessions
                        .map((x, i) => {
                          const room = roomById(x.screenId);
                          return `${i + 1}: ${room ? `${room.venueName} · ${room.name}` : 'general admission'}`;
                        })
                        .join(', ')
              }
            />
            <Row
              label="Ticket types"
              value={
                allSeated
                  ? 'From the seat map — one per seat category'
                  : tickets
                      .filter((t) => !sessions[t.sessionIndex]?.screenId)
                      .map(
                        (t) =>
                          `${t.name} (${isFree ? 'Free' : money(Math.round(Number(t.priceMajor) * 100), eventCurrency)} × ${t.quantityTotal})`,
                      )
                      .join(', ')
              }
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
