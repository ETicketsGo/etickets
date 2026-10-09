'use client';

import { useQuery } from '@tanstack/react-query';
import { useRouter, useSearchParams } from 'next/navigation';
import { Suspense, useEffect, useRef, useState, type ReactNode } from 'react';
import {
  api,
  Button,
  Card,
  Input,
  Select,
  Textarea,
  PageHeader,
  Skeleton,
  useToast,
  errorMessage,
  money,
  currencyForCountry,
  DateTimeField,
  LocationFields,
  defaultLocation,
  termsList,
  dateTime,
  zoneAbbrev,
  type LocationValue,
} from '@eticketsgo/web-kit';
import { venuePayload } from '@/components/venue-fields';
import { useOrg } from '@/components/org-context';
import { WizardSteps } from '@/components/wizard-steps';
import { getTemplate, EVENT_CATEGORIES, isListedCategory } from '@/lib/templates';
import { clearEventDraft, draftAge, readEventDraft, saveEventDraft } from '@/lib/event-draft';
import {
  ADMISSION_CHOICES,
  EMPTY_SESSION,
  REVIEW_STEP,
  WIZARD_STEPS,
  buyerFeeNote,
  canVisitStep,
  capacityBySession,
  describeProblems,
  firstInvalidFieldId,
  fromPriceMinor,
  initialWizardDraft,
  isFreeAdmission,
  isMeaningfulDraft,
  newTicketRow,
  restoreWizardDraft,
  sessionsToSend,
  stepStatus,
  ticketsToSend,
  validateAll,
  whatHappensNext,
  type Admission,
  type FieldErrors,
  type SessionDraft,
  type TicketDraft,
  type WizardDraft,
} from '@/lib/event-wizard';
import { EventPreviewCard } from '@/components/event-preview-card';
import {
  EMPTY_EVENT_DETAILS,
  EventDetailsFields,
  eventDetailsBody,
  type EventDetailsValue,
} from '@/components/event-details-fields';
import {
  EVENT_IMAGE_MAX_COUNT,
  EventGalleryEditor,
  prepareEventImage,
} from '@/components/event-image-picker';

/*
  ── ONE QUESTION PER STEP ──────────────────────────────────────────────────────────
  Founder feedback: a first-time organizer opened this page and did not know what to fill in
  first, what was needed before they could sell, or what the last button would do. The first
  step held eight different kinds of question, and venue and sessions - which are one
  decision, "where and when" - were two.

  The steps, their required fields and the rules for moving between them are in
  `lib/event-wizard`, where they are tested. This page renders them and makes the same API
  calls in the same order it always has.

  "Fee handling" is still not a step. It was one dropdown with a correct default already
  selected, asking somebody publishing one comedy night to form a policy on fee incidence - a
  concept of OURS - before they could sell a ticket. It lives on Review, answered and
  changeable.
*/
const FEE_MODES = [
  { value: 'CUSTOMER_PAYS', label: 'Customer pays fees' },
  { value: 'ORGANIZER_PAYS', label: 'Organizer absorbs fees' },
  { value: 'SHARED', label: 'Shared 50/50' },
];

const REFUND_CUTOFFS: { value: string; label: string }[] = [
  { value: '0', label: 'Right up to start time' },
  { value: '2', label: '2 hours before' },
  { value: '24', label: '24 hours before' },
  { value: '48', label: '48 hours before' },
  { value: '72', label: '3 days before' },
  { value: '168', label: '7 days before' },
  { value: '336', label: '14 days before' },
];

/** A session's start, as the organizer chose it - the thing that tells two sessions apart. */
function sessionWhen(s: SessionDraft, index: number): string {
  return s.startsAt
    ? new Date(s.startsAt).toLocaleString('en-IN', {
        day: 'numeric',
        month: 'short',
        hour: 'numeric',
        minute: '2-digit',
      })
    : `Session ${index + 1} — no time set`;
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
  /*
    The furthest step reached. Every step up to it can be jumped to from the indicator, and is
    shown as complete or as needing attention; the ones after it have not been asked yet.
  */
  const [furthest, setFurthest] = useState(0);
  const [error, setError] = useState<string | null>(null);
  /* Which problems on the current step have been pointed out. Shown with their LIVE message. */
  const [shownErrors, setShownErrors] = useState<FieldErrors>({});
  const [busy, setBusy] = useState(false);

  const venuesQ = useQuery({
    queryKey: ['venues', activeOrg.id],
    queryFn: () => api.venues.list(activeOrg.id),
  });
  /*
    The rooms with a published seat map, fetched up front so the sessions can offer reserved
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

  /*
    The form as it opens, from one definition in `lib/event-wizard` - the same one that decides
    whether a saved draft has anything in it. Worked out once: the template is read from the URL
    on arrival and is not a reason to reset the form later.

    A template can seed a category that is not on the list, so the category mode is derived from
    the seed rather than defaulting to the tiles - otherwise the wizard would open with no tile
    selected, silently losing what the template chose.
  */
  const [initial] = useState(() =>
    initialWizardDraft({
      title: template?.suggestedTitle,
      category: template?.category,
      description: template?.description,
      categoryMode: template && !isListedCategory(template.category) ? 'other' : 'list',
    }),
  );
  const [basics, setBasics] = useState(initial.basics);
  const [details, setDetails] = useState<EventDetailsValue>(EMPTY_EVENT_DETAILS);
  /* Whether the category is being picked or typed. */
  const [categoryMode, setCategoryMode] = useState<'list' | 'other'>(initial.categoryMode);
  /*
    How people get in: free, paid general admission or reserved seating.

    Free is declared rather than inferred from the prices. Deriving it would make the event
    flip between free and paid as somebody edited a number, and free is not a price — it
    changes what the platform DOES. No payment provider is called, no booking fee and no
    platform share are taken, and the buyer never sees a checkout. Everything after the money
    is unchanged: tickets, QR codes, cancellation.
  */
  const [admission, setAdmission] = useState<Admission>(initial.admission);
  const isFree = isFreeAdmission(admission);
  const [venueMode, setVenueMode] = useState<'existing' | 'new'>(initial.venueMode);
  const [venueId, setVenueId] = useState(initial.venueId);
  const [newVenue, setNewVenue] = useState(initial.newVenue);
  // Same three interdependent answers as the venues page, from the same component — a venue
  // created mid-wizard is a venue, and it was previously created without a state or a clock.
  const [newVenueWhere, setNewVenueWhere] = useState<LocationValue>(defaultLocation);
  const [feeMode, setFeeMode] = useState(initial.feeMode);

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
  /* The clock the buyer reads the start time in: the venue's, never the visitor's. */
  const eventTimezone =
    venueMode === 'new' ? newVenueWhere.timezone : (chosenVenue?.timezone ?? undefined);
  const [sessions, setSessions] = useState<SessionDraft[]>(initial.sessions);
  const [tickets, setTickets] = useState<TicketDraft[]>(initial.tickets);

  /*
    ── THE DRAFT SURVIVES LEAVING THIS PAGE ──────────────────────────────────────────
    The only route to a seat map is another screen, and this wizard held everything in
    component state — so the product sent an organizer away to create a room and then threw
    away everything they had typed. Reported exactly that way, and the second half of the
    complaint ("it is still in rooms section") is the same defect: nothing brought them back.

    Saved on every change and restored on return, with the organizer told it happened. Cleared
    the moment a real event exists, so a finished wizard never offers to restore itself.
  */
  const draftState: WizardDraft = {
    step,
    furthest,
    basics,
    details,
    categoryMode,
    admission,
    venueMode,
    venueId,
    newVenue,
    newVenueWhere,
    feeMode,
    sessions,
    tickets,
  };
  const [restoredAt, setRestoredAt] = useState<number | null>(null);
  /*
    Set once a draft has been considered, so the first render cannot save over it.

    State, not a ref. A ref flipped inside the restore effect was already true when the save
    effect ran in the SAME commit - with that render's still-empty answers - so the empty form
    was written over the draft before the restored one replaced it. React's development mode
    runs effects twice on mount, and the second restore then read back the empty copy: the
    page said "Picked up where you left off" over a blank form. A state change is only seen by
    the NEXT render, which is the one holding the restored answers.
  */
  const [hydrated, setHydrated] = useState(false);
  /*
    Set once the event really exists, so nothing can write the draft back.

    Reported: "I created an event yesterday and published it; creating a new event still shows
    the previous event's review page". The draft WAS cleared after creation — and the save
    effect below, which runs after every render, wrote it straight back on the next one (the
    success toast is enough) before the navigation away had finished. The finished event then
    came back as a draft at the Review step, every time.
  */
  const committed = useRef(false);

  /*
    The images, already resized and in the organizer's order, held until the event exists to
    attach them to. The first is the cover.

    Deliberately NOT part of the saved draft: the draft is localStorage, a few megabytes for the
    whole origin, and images would crowd out the answers it exists to protect. A restored draft
    says so beside the picker.
  */
  const [images, setImages] = useState<{ key: string; blob: Blob; url: string }[]>([]);
  const [imageError, setImageError] = useState<string | null>(null);
  const [preparingImages, setPreparingImages] = useState(false);
  const imagesRef = useRef(images);
  imagesRef.current = images;
  // Object URLs are released when the wizard goes away; each removal releases its own.
  useEffect(() => () => imagesRef.current.forEach((image) => URL.revokeObjectURL(image.url)), []);

  const addImages = async (files: File[]) => {
    setImageError(null);
    setPreparingImages(true);
    const room = EVENT_IMAGE_MAX_COUNT - imagesRef.current.length;
    const prepared: { key: string; blob: Blob; url: string }[] = [];
    let problem: string | null =
      files.length > room
        ? `Only ${EVENT_IMAGE_MAX_COUNT} images fit — the first ${Math.max(room, 0)} were added.`
        : null;
    for (const file of files.slice(0, Math.max(room, 0))) {
      try {
        const blob = await prepareEventImage(file);
        prepared.push({ key: crypto.randomUUID(), blob, url: URL.createObjectURL(blob) });
      } catch (err) {
        problem = `${file.name}: ${err instanceof Error ? err.message : 'could not be used.'}`;
      }
    }
    setImages((current) => [...current, ...prepared]);
    setImageError(problem);
    setPreparingImages(false);
  };

  useEffect(() => {
    const found = readEventDraft<unknown>(activeOrg.id);
    setHydrated(true);
    if (!found) return;
    // Checked field by field: storage is outside this page's control, and a draft of the
    // wrong shape is refused whole rather than half-restored.
    const d = restoreWizardDraft(found.data);
    if (!d) return;
    /*
      A draft with nothing the organizer entered is thrown away without a word. Restoring it
      would change nothing on screen and still say "Picked up where you left off" - about work
      that never happened.
    */
    if (!isMeaningfulDraft(d, initial)) {
      clearEventDraft(activeOrg.id);
      return;
    }
    setStep(d.step);
    setFurthest(d.furthest);
    setBasics(d.basics);
    setDetails(d.details);
    setCategoryMode(d.categoryMode);
    setAdmission(d.admission);
    setVenueMode(d.venueMode);
    setVenueId(d.venueId);
    setNewVenue(d.newVenue);
    setNewVenueWhere(d.newVenueWhere ?? defaultLocation);
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
    // Never after the event exists, or a finished event is offered back as a draft.
    if (!hydrated || committed.current) return;
    /*
      A form with nothing entered is not saved. Saving it is what produced the false "Picked up
      where you left off": merely opening this page wrote a draft of the blank form, and the
      next visit announced it. Clearing rather than skipping also covers somebody who typed and
      then emptied every field - their draft is now blank too.
    */
    if (isMeaningfulDraft(draftState, initial)) saveEventDraft(activeOrg.id, draftState);
    else clearEventDraft(activeOrg.id);
  });

  /*
    The seat maps that can be used at THIS venue.

    The list from the server is every space in the organization with a published layout. The
    sessions used to offer all of them, so a concert at one venue could be seated in a hall of
    another - and the event page would then name one building while the tickets named another.
    A venue being created here has no spaces yet, so it has none.
  */
  const venueRooms =
    venueMode === 'existing' && venueId
      ? (roomsQ.data ?? []).filter((r) => r.venueId === venueId)
      : [];
  /* Null while the list is loading or failed: nothing can be judged against an unknown list. */
  const venueSeatMaps = roomsQ.data ? venueRooms.map((r) => r.layoutId) : null;
  const seatingAvailable = venueRooms.length > 0;
  const roomByLayout = (seatMapId: string) => roomsQ.data?.find((r) => r.layoutId === seatMapId);

  /* Every step's problems, from the answers as they are now. Cheap, so worked out per render. */
  const answers = {
    basics,
    admission,
    venueMode,
    venueId,
    newVenue,
    sessions,
    tickets,
    venueSeatMaps,
  };
  const errorsByStep = validateAll(answers);
  const statuses = WIZARD_STEPS.map((_, i) => stepStatus(i, step, furthest, errorsByStep));
  /*
    The errors on screen: the ones already pointed out, with today's wording, and only while
    they are still true. Fixing a field clears its message as soon as it is fixed, instead of
    leaving it on screen until the next press of Next.
  */
  const liveErrors = errorsByStep[WIZARD_STEPS[step].id];
  const fieldErrors: FieldErrors = Object.fromEntries(
    Object.keys(shownErrors)
      .filter((key) => key in liveErrors)
      .map((key) => [key, liveErrors[key]]),
  );

  /*
    ── WHERE THE CURSOR GOES ────────────────────────────────────────────────────────
    A new step puts focus on its heading, so a screen reader announces where the organizer has
    arrived and Tab starts from the top of it. A refused step puts focus in the first field
    that is wrong, which is the one thing they need to do next. Not on the first render: the
    title field has focus by then, and that is right for somebody who just opened the page.
  */
  const headingRef = useRef<HTMLHeadingElement>(null);
  const pendingFocus = useRef<string | null>(null);
  const [focusRequest, setFocusRequest] = useState(0);
  const firstFocusPass = useRef(true);
  useEffect(() => {
    if (firstFocusPass.current) {
      firstFocusPass.current = false;
      return;
    }
    const id = pendingFocus.current;
    pendingFocus.current = null;
    const field = id ? document.getElementById(id) : null;
    (field ?? headingRef.current)?.focus();
  }, [step, focusRequest]);

  /** Stop on a step and show what is wrong with it. */
  const showProblems = (index: number, errs: FieldErrors) => {
    setStep(index);
    setShownErrors(errs);
    setError(errs.form ?? null);
    pendingFocus.current = firstInvalidFieldId(errs, categoryMode);
    setFocusRequest((n) => n + 1);
  };

  /*
    Every move between steps, from Back, Next or the indicator.

    Backwards is always allowed and never judged - people go back to look. Forwards checks each
    step being passed over, in order, and stops on the first one with a problem: Next checks
    only the step it leaves, and a jump from the indicator checks the same steps Next would
    have, so the two can never disagree about what is required.
  */
  const goTo = (target: number) => {
    if (target < 0 || target > REVIEW_STEP || target === step) return;
    if (target > step) {
      for (let i = step; i < target; i += 1) {
        const errs = errorsByStep[WIZARD_STEPS[i].id];
        if (Object.keys(errs).length > 0) {
          showProblems(i, errs);
          return;
        }
      }
    }
    setStep(target);
    setFurthest((f) => Math.max(f, target));
    setError(null);
    // Arriving at a step already flagged shows its problems at once - that is why they came.
    const errs = statuses[target] === 'error' ? errorsByStep[WIZARD_STEPS[target].id] : {};
    setShownErrors(errs);
    if (errs.form) setError(errs.form);
  };

  /*
    Answer "how do people get in".

    Choosing reserved seating fills in the seat map wherever there is only one to choose, and
    keeps a session's earlier choice when it is still at this venue. Choosing free or paid
    leaves the seat choices where they are: nothing is sent with them (`sessionsToSend`), and
    changing your mind back to seating should not mean choosing them all again.
  */
  const chooseAdmission = (next: Admission) => {
    setAdmission(next);
    if (next !== 'seated') return;
    const only = venueRooms.length === 1 ? venueRooms[0] : null;
    setSessions((prev) =>
      prev.map((s) =>
        s.seatMapId && venueSeatMaps?.includes(s.seatMapId)
          ? s
          : { ...s, screenId: only?.id ?? '', seatMapId: only?.layoutId ?? '' },
      ),
    );
  };

  const commit = async (submitForReview: boolean) => {
    /*
      Checked again, all of it. The indicator lets an organizer go back and change an earlier
      answer, so "every step was valid when it was passed" no longer means it is valid now.
    */
    const bad = WIZARD_STEPS.findIndex((s) => Object.keys(errorsByStep[s.id]).length > 0);
    if (bad !== -1) {
      showProblems(bad, errorsByStep[WIZARD_STEPS[bad].id]);
      setError(
        errorsByStep[WIZARD_STEPS[bad].id].form ??
          `Fix the answers marked on this step before the event can be created.`,
      );
      return;
    }
    setBusy(true);
    setError(null);
    /*
      The event's id once it exists. A failure after that point must not leave the organizer on
      this page with a button that creates the event AGAIN: they are taken to the event that
      now exists and told what did not finish, where it can be finished.
    */
    let createdId: string | null = null;
    try {
      let finalVenueId = venueId;
      if (venueMode === 'new') {
        /*
          ONE payload, shared with /organizer/venues and onboarding. This screen used to
          build its own and omitted `address`, so a venue created while making an event had
          no street address and no way to add one from here - the same action producing a
          different object depending on which door the organizer came through.
        */
        const created = await api.venues.create({
          organizationId: activeOrg.id,
          ...venuePayload({
            name: newVenue.name,
            city: newVenue.city,
            address: newVenue.address ?? '',
            capacity: newVenue.capacity ?? '',
            where: newVenueWhere,
          }),
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
        ...eventDetailsBody(details),
      });
      createdId = event.id;
      const sessionIds: string[] = [];
      // Only reserved seating sends a room; see `sessionsToSend`.
      for (const s of sessionsToSend({ admission, sessions })) {
        const created = await api.events.addSession(event.id, {
          startsAt: new Date(s.startsAt).toISOString(),
          endsAt: new Date(s.endsAt).toISOString(),
          // Omitted rather than sent empty: '' is a room id that does not exist, and the
          // request would be refused instead of understood as "no room".
          ...(s.screenId ? { screenId: s.screenId } : {}),
          ...(s.seatMapId ? { seatMapId: s.seatMapId } : {}),
        });
        sessionIds.push(created.id);
      }
      /*
        Seated sessions are skipped. Their ticket types already exist — created from the
        room's seat categories — and adding more here would put two competing prices on the
        same night.
      */
      for (const t of ticketsToSend({ admission, sessions, tickets })) {
        await api.events.addTicketType({
          eventSessionId: sessionIds[t.sessionIndex] ?? sessionIds[0],
          name: t.name,
          // Zero regardless of what the price box happens to hold: a free event's ticket
          // types must all be zero and the API refuses anything else, so sending the stale
          // contents of a hidden field would fail the whole creation with a confusing error.
          priceMinor: isFree ? 0 : Math.round(Number(t.priceMajor) * 100),
          quantityTotal: Number(t.quantityTotal),
          maxPerOrder: Number(t.maxPerOrder) || 10,
        });
      }
      /*
        Attached before submitting, in the organizer's order — so the first uploaded is the
        cover, and the admin reviewing the event sees the images buyers will. One at a time so
        the order on the server is the order chosen here. A failed upload does not undo an
        event that now exists; the organizer is told, and can add the rest from Edit.
      */
      let imageFailed: string | null = null;
      let imagesFailed = 0;
      for (const image of images) {
        try {
          await api.events.addImage(event.id, image.blob);
        } catch (err) {
          imagesFailed += 1;
          imageFailed = errorMessage(err);
        }
      }
      /*
        A refused submission leaves a complete DRAFT, not a failed creation. The API refuses
        to submit an event nobody could buy from, and it is right to - but the event, its
        sessions and its tickets all exist by then. Staying here with the error would invite a
        second press that creates the whole event a second time.
      */
      let submitRefused: string | null = null;
      if (submitForReview) {
        try {
          await api.events.submit(event.id);
        } catch (err) {
          submitRefused = errorMessage(err);
        }
      }
      // The event exists; the draft is now a duplicate of something real. Stop saving FIRST —
      // the toast below re-renders this page, and that render would write the draft back.
      committed.current = true;
      clearEventDraft();
      if (submitRefused) {
        toast.push(
          `Your event was saved as a draft, but it could not be submitted yet: ${submitRefused}`,
          'error',
        );
      } else {
        toast.push(
          submitForReview ? 'Event submitted for review.' : 'Draft event created.',
          'success',
        );
      }
      if (imageFailed) {
        toast.push(
          `${imagesFailed === 1 ? 'An image was' : `${imagesFailed} images were`} not uploaded: ${imageFailed} Add ${imagesFailed === 1 ? 'it' : 'them'} from Edit event.`,
          'error',
        );
      }
      router.push(`/organizer/events/${event.id}`);
    } catch (err) {
      if (createdId) {
        committed.current = true;
        clearEventDraft();
        toast.push(
          `Your event was created as a draft, but not everything was added: ${errorMessage(err)} Finish it from the event page.`,
          'error',
        );
        router.push(`/organizer/events/${createdId}`);
        return;
      }
      setError(errorMessage(err));
      setBusy(false);
    }
  };

  const happens = whatHappensNext(Boolean(activeOrg.autoApproveEvents));
  const current = WIZARD_STEPS[step];
  const sentTickets = ticketsToSend({ admission, sessions, tickets });
  const currentProblems = describeProblems(liveErrors);
  /* Every step that still needs something, for Review. Create is disabled until it is empty. */
  const outstanding = WIZARD_STEPS.map((s, index) => ({
    index,
    title: s.title,
    problems: describeProblems(errorsByStep[s.id]),
  })).filter((s) => s.problems.length > 0);
  const totals = capacityBySession({ admission, sessions, tickets });

  /* The preview on Review: the facts a buyer decides on, as the storefront will show them. */
  // Only complete times: a date picked before its time is not a moment yet, and
  // `toISOString` throws on it - mid-typing, on every render.
  const firstStartMs = sessions
    .map((s) => (s.startsAt ? new Date(s.startsAt).getTime() : NaN))
    .filter((ms) => Number.isFinite(ms))
    .sort((a, b) => a - b)[0];
  const firstStartIso = firstStartMs !== undefined ? new Date(firstStartMs).toISOString() : null;
  const previewWhen = firstStartIso
    ? `${dateTime(firstStartIso, undefined, eventTimezone)}${
        eventTimezone ? ` (${zoneAbbrev(firstStartIso, eventTimezone)})` : ''
      }`
    : 'No date yet';
  const previewWhere =
    venueMode === 'existing'
      ? chosenVenue
        ? `${chosenVenue.name}, ${chosenVenue.city}`
        : 'No venue yet'
      : newVenue.name
        ? `${newVenue.name}, ${newVenue.city}`
        : 'No venue yet';
  const previewFromMinor = fromPriceMinor({ admission, sessions, tickets });
  const previewPrice =
    previewFromMinor === 0
      ? 'Free'
      : previewFromMinor !== null
        ? money(previewFromMinor, eventCurrency)
        : admission === 'seated'
          ? 'Priced from the seat map'
          : 'No price yet';

  return (
    <div className="mx-auto max-w-2xl space-y-6">
      <PageHeader
        title="Create event"
        breadcrumbs={[{ label: 'Events', href: '/organizer/events' }, { label: 'New' }]}
      />

      <WizardSteps
        steps={WIZARD_STEPS}
        current={step}
        statuses={statuses}
        canVisit={(i) => canVisitStep(i, furthest)}
        onVisit={goTo}
      />

      {/*
        Say that the form was refilled.

        Silently restoring somebody's work is nearly as disorienting as losing it — they came
        back expecting a blank wizard and found one with answers in it. Saying where those
        came from, and offering to throw them away, turns a surprise into a choice.
      */}
      {restoredAt !== null && (
        <div className="flex flex-wrap items-center justify-between gap-3 rounded-md border border-border bg-background-subtle px-4 py-3">
          <p className="text-caption text-text-secondary">
            Picked up where you left off. Saved {draftAge(restoredAt)}.
          </p>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => {
              // Stop saving first, or a render before the reload writes the draft back.
              committed.current = true;
              clearEventDraft(activeOrg.id);
              window.location.reload();
            }}
          >
            Start over
          </Button>
        </div>
      )}

      <Card>
        <div className="mb-5">
          <h2
            ref={headingRef}
            tabIndex={-1}
            className="text-lg font-semibold text-text-primary focus:outline-none"
          >
            {current.title}
          </h2>
          <p className="mt-1 text-caption text-text-muted">{current.intro}</p>
          {/*
            What is still missing on this step, in words, from the answers as they are now.

            The fixed "Required: ..." line said what a step needs in general; it could not say
            what THIS organizer has not done yet, so the first they heard of a missing end time
            was a refused Next. The list shrinks as they fill the form in, and when it is empty
            the general line comes back. Review lists every step instead (below).
          */}
          {current.id !== 'review' && currentProblems.length > 0 ? (
            <div className="mt-2 text-caption text-text-secondary">
              <p className="font-medium">Still needed on this step:</p>
              <ul className="mt-1 list-disc space-y-0.5 pl-5">
                {currentProblems.map((problem) => (
                  <li key={problem}>{problem}</li>
                ))}
              </ul>
            </div>
          ) : (
            <p className="mt-1 text-caption font-medium text-text-secondary">{current.required}</p>
          )}
        </div>

        {current.id === 'basics' && (
          <div className="space-y-4">
            {/*
              The first question is what kind of event this is, asked as a set of choices
              rather than a dropdown: a first-time organizer recognises their event in a list
              they can see, where a closed select hides the options until it is opened.
              Radios underneath, so it is one tab stop with arrow keys, like any radio group.
            */}
            <fieldset>
              <legend className="mb-2 text-[0.9375rem] font-medium text-text-primary">
                What are you organizing?
              </legend>
              <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-4">
                {[...EVENT_CATEGORIES, '__other'].map((c, i) => {
                  const checked =
                    c === '__other'
                      ? categoryMode === 'other'
                      : categoryMode === 'list' && basics.category === c;
                  return (
                    <label
                      key={c}
                      className={`relative flex min-h-11 cursor-pointer items-center justify-center rounded-md border px-3 py-2.5 text-center text-sm font-medium transition-colors focus-within:ring-2 focus-within:ring-ring/50 ${
                        checked
                          ? 'border-action-primary bg-tint-primary text-text-primary'
                          : 'border-border text-text-secondary hover:bg-background-subtle'
                      }`}
                    >
                      <input
                        type="radio"
                        name="category"
                        // The first option carries the id, so "fix this field" focuses the group.
                        id={i === 0 ? 'category' : undefined}
                        className="absolute inset-0 m-0 cursor-pointer appearance-none rounded-md opacity-0"
                        value={c}
                        checked={checked}
                        aria-invalid={
                          categoryMode === 'list' && fieldErrors.category ? true : undefined
                        }
                        onChange={() => {
                          if (c === '__other') {
                            setCategoryMode('other');
                            setBasics((b) => ({ ...b, category: '' }));
                          } else {
                            setCategoryMode('list');
                            setBasics((b) => ({ ...b, category: c }));
                          }
                        }}
                      />
                      {c === '__other' ? 'Something else' : c}
                    </label>
                  );
                })}
              </div>
              {categoryMode === 'list' && fieldErrors.category ? (
                <p role="alert" className="mt-1.5 text-caption text-status-error">
                  {fieldErrors.category}
                </p>
              ) : null}
            </fieldset>

            {categoryMode === 'other' && (
              <Input
                id="category-other"
                label="Your category"
                autoFocus
                required
                placeholder="e.g. Poetry reading"
                value={basics.category}
                onChange={(e) => setBasics({ ...basics, category: e.target.value })}
                error={fieldErrors.category}
              />
            )}
            <Input
              id="title"
              label="Event title"
              required
              value={basics.title}
              onChange={(e) => setBasics({ ...basics, title: e.target.value })}
              error={fieldErrors.title}
            />
            <Textarea
              id="desc"
              label="Description"
              rows={4}
              hint="Optional. What buyers read on the event page."
              value={basics.description}
              onChange={(e) => setBasics({ ...basics, description: e.target.value })}
            />
          </div>
        )}

        {current.id === 'where' && (
          <div className="space-y-6">
            <section aria-labelledby="where-venue" className="space-y-4">
              <h3 id="where-venue" className="text-sm font-semibold text-text-primary">
                Where
              </h3>
              <div className="flex flex-wrap gap-2">
                <Button
                  variant={venueMode === 'existing' ? 'primary' : 'outline'}
                  aria-pressed={venueMode === 'existing'}
                  onClick={() => setVenueMode('existing')}
                >
                  Existing venue
                </Button>
                <Button
                  variant={venueMode === 'new' ? 'primary' : 'outline'}
                  aria-pressed={venueMode === 'new'}
                  onClick={() => setVenueMode('new')}
                >
                  New venue
                </Button>
              </div>
              {venueMode === 'existing' ? (
                <Select
                  id="venue"
                  label="Venue"
                  required
                  value={venueId}
                  onChange={(e) => setVenueId(e.target.value)}
                  error={fieldErrors.venueId}
                  hint="The venue's country sets the currency you sell in."
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
                      required
                      value={newVenue.name}
                      onChange={(e) => setNewVenue({ ...newVenue, name: e.target.value })}
                      error={fieldErrors.venueName}
                    />
                    <Input
                      id="vcity"
                      label="City"
                      required
                      value={newVenue.city}
                      onChange={(e) => setNewVenue({ ...newVenue, city: e.target.value })}
                      error={fieldErrors.venueCity}
                    />
                    {/*
                      The field this screen used to omit entirely. A venue created here had no
                      street address and no way to add one without leaving event creation.
                    */}
                    <Input
                      id="vaddress"
                      label="Street address"
                      hint="Just the street and area. The city is set above."
                      value={newVenue.address}
                      onChange={(e) => setNewVenue({ ...newVenue, address: e.target.value })}
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
                      hint="How many people the space holds. Each ticket type sets its own quantity — we warn you if they add up to more than this."
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
            </section>

            <section aria-labelledby="where-when" className="space-y-4">
              <h3 id="where-when" className="text-sm font-semibold text-text-primary">
                When
              </h3>
              <p className="text-caption text-text-muted">
                Add a session for each date and time. A run of three nights is one event with three
                sessions.
              </p>
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
                    Seating is no longer chosen here. It is one of the three answers to "how do
                    people get in" on the next step, where it sits beside free and paid and is
                    offered only when this venue has a seat map.
                  */}
                  {sessions.length > 1 && (
                    <Button
                      variant="ghost"
                      size="sm"
                      className="justify-self-start text-status-error"
                      onClick={() => {
                        setSessions(sessions.filter((_, j) => j !== i));
                        /*
                          Ticket rows point at sessions by position, so removing one shifts every
                          later session down by one. Without this, a row for the third night would
                          quietly become a row for the fourth - or for no night at all. Rows of
                          the removed session move to the first session, where they stay visible.
                        */
                        setTickets((prev) =>
                          prev.map((t) => ({
                            ...t,
                            sessionIndex:
                              t.sessionIndex === i
                                ? 0
                                : t.sessionIndex > i
                                  ? t.sessionIndex - 1
                                  : t.sessionIndex,
                          })),
                        );
                      }}
                    >
                      Remove session {i + 1}
                    </Button>
                  )}
                </div>
              ))}
              <Button
                variant="outline"
                onClick={() =>
                  setSessions([
                    ...sessions,
                    /*
                      A new night of a seated run is seated where the last one was. Starting it
                      blank would leave a session the next step refuses, for an answer the
                      organizer has already given once.
                    */
                    admission === 'seated'
                      ? {
                          ...EMPTY_SESSION,
                          screenId: sessions[sessions.length - 1]?.screenId ?? '',
                          seatMapId: sessions[sessions.length - 1]?.seatMapId ?? '',
                        }
                      : { ...EMPTY_SESSION },
                  ])
                }
              >
                + Add session
              </Button>
            </section>
          </div>
        )}

        {current.id === 'tickets' && (
          <div className="space-y-5">
            {/*
              ── HOW PEOPLE GET IN, ASKED FIRST ──────────────────────────────────────────
              Three answers, as tiles like "What are you organizing?", because each one changes
              what the rest of the step asks: free needs no prices, paid needs ticket types with
              prices, and reserved seating needs a seat map per session and no ticket types at
              all. Asked as one question, only the questions that matter are shown after it.

              Radios underneath, so it is one tab stop with arrow keys. Each tile is at least
              44px tall, the smallest target a thumb hits reliably.
            */}
            <fieldset>
              <legend className="mb-2 text-[0.9375rem] font-medium text-text-primary">
                How do people get in?
              </legend>
              <div className="grid gap-2 sm:grid-cols-3">
                {ADMISSION_CHOICES.map((choice, i) => {
                  const checked = admission === choice.value;
                  const unavailable = choice.value === 'seated' && !seatingAvailable;
                  const description =
                    choice.value === 'free'
                      ? 'Nobody pays. No checkout and no fees.'
                      : choice.value === 'paid'
                        ? 'Buyers choose how many tickets they want.'
                        : unavailable
                          ? roomsQ.isLoading
                            ? 'Checking this venue for a seat map...'
                            : 'Needs a seat map at this venue.'
                          : 'Buyers pick a named seat from the seat map.';
                  return (
                    <label
                      key={choice.value}
                      className={`relative flex min-h-11 flex-col justify-center rounded-md border px-3 py-2.5 text-sm transition-colors focus-within:ring-2 focus-within:ring-ring/50 ${
                        unavailable
                          ? 'cursor-not-allowed border-border text-text-muted'
                          : checked
                            ? 'cursor-pointer border-action-primary bg-tint-primary text-text-primary'
                            : 'cursor-pointer border-border text-text-secondary hover:bg-background-subtle'
                      }`}
                    >
                      <input
                        type="radio"
                        name="admission"
                        // The first option carries the id, so "fix this field" focuses the group.
                        id={i === 0 ? 'admission' : undefined}
                        className="absolute inset-0 m-0 cursor-pointer appearance-none rounded-md opacity-0 disabled:cursor-not-allowed"
                        value={choice.value}
                        checked={checked}
                        disabled={unavailable && !checked}
                        aria-labelledby={`admission-${choice.value}`}
                        aria-describedby={`admission-${choice.value}-hint`}
                        onChange={() => chooseAdmission(choice.value)}
                      />
                      <span id={`admission-${choice.value}`} className="font-medium">
                        {choice.label}
                      </span>
                      <span
                        id={`admission-${choice.value}-hint`}
                        // Muted text fails contrast on the selected tile's tint, so it darkens there.
                        className={`mt-0.5 text-caption ${checked ? 'text-text-secondary' : 'text-text-muted'}`}
                      >
                        {description}
                      </span>
                    </label>
                  );
                })}
              </div>
              {fieldErrors.admission ? (
                <p role="alert" className="mt-1.5 text-caption text-status-error">
                  {fieldErrors.admission}
                </p>
              ) : null}
              {/*
                ── WHY RESERVED SEATING IS SOMETIMES NOT ON OFFER ──────────────────────────
                It needs a PUBLISHED seat map in a space of this venue, and a new organization
                has none. A greyed-out tile with no way forward reads as broken, so the way to
                get one is said here, as a link.

                Opened in a NEW TAB, deliberately. Drawing a seat map lives on another screen,
                and sending somebody there mid-wizard is what once lost their work. The draft
                survives either way now, but not leaving at all beats leaving and being
                restored: the half-filled form stays on screen behind them.
              */}
              {!seatingAvailable && !roomsQ.isLoading && (
                <p className="mt-2 text-caption text-text-muted">
                  {roomsQ.isError
                    ? 'We could not check this venue for seat maps, so reserved seating is not on offer right now. '
                    : venueMode === 'new'
                      ? 'A new venue has no seat map yet, so reserved seating is not on offer. '
                      : "Reserved seating needs a published seat map in one of this venue's spaces, and it has none yet. "}
                  To sell numbered seats, draw one in{' '}
                  <a
                    href="/organizer/venues"
                    target="_blank"
                    rel="noopener noreferrer"
                    className="font-medium text-action-primary underline underline-offset-2"
                  >
                    Venues and spaces (opens in a new tab)
                  </a>
                  . What you have typed here is saved either way.
                </p>
              )}
            </fieldset>

            {admission === 'seated' && (
              <div className="space-y-4">
                {/*
                  Nothing to price. Each session in a seated space gets one ticket type per
                  seat category, priced from the category, because a seat's price is a fact
                  about where it is in the room. Asking for ticket types as well would produce a
                  second, conflicting set of prices - and the room's would win at the point of
                  sale, silently.
                */}
                <div className="rounded-md border border-border p-4 text-sm">
                  <p className="font-medium">Ticket types come from the seat map</p>
                  <p className="mt-1 text-text-muted">
                    A ticket type is created for each seat category and priced from it. You can
                    change prices per session afterwards from the event&apos;s pricing page.
                  </p>
                </div>
                {sessions.map((s, i) => (
                  <Select
                    key={i}
                    id={`sr${i}`}
                    label={
                      sessions.length === 1
                        ? 'Seat map'
                        : `Seat map for session ${i + 1} (${sessionWhen(s, i)})`
                    }
                    required
                    value={s.seatMapId}
                    error={fieldErrors[`s${i}Seat`]}
                    onChange={(e) => {
                      const seatMapId = e.target.value;
                      const room = venueRooms.find((r) => r.layoutId === seatMapId);
                      setSessions(
                        sessions.map((x, j) =>
                          j === i ? { ...x, seatMapId, screenId: room?.id ?? '' } : x,
                        ),
                      );
                    }}
                  >
                    <option value="">Choose a seat map...</option>
                    {venueRooms.map((r) => (
                      <option key={r.layoutId} value={r.layoutId}>
                        {r.name} - {r.layoutName ?? 'Layout'} ({r.sellableSeats} seats)
                      </option>
                    ))}
                  </Select>
                ))}
              </div>
            )}

            {(admission === 'free' || admission === 'paid') && (
              <div className="space-y-4">
                {isFree && (
                  <p className="rounded-md border border-border bg-background-subtle p-3 text-sm text-text-secondary">
                    Nobody is charged, so there is no checkout, no booking fee and no platform
                    share. Attendees still book, get tickets and QR codes, and can cancel.
                  </p>
                )}
                {/*
                  ── MORE TICKETS THAN THE ROOM HOLDS ──────────────────────────────────────
                  A warning, not a block. Overselling a stated capacity is usually a mistake
                  and occasionally deliberate — standing room, a capacity nobody updated, two
                  sessions sharing one venue record — and the platform does not know which.
                  What it can do is notice, say so with both numbers, and let the organizer
                  decide.

                  Counted per SESSION, because that is what fills the room. Summing every
                  ticket type across a three-night run and comparing that to one night's
                  capacity would cry wolf on the most ordinary setup there is.
                */}
                {venueCapacity !== null &&
                  totals.map((forSession, i) => {
                    if (forSession <= venueCapacity) return null;
                    return (
                      <p
                        key={`cap-${i}`}
                        role="status"
                        className="rounded-md border border-status-warning/40 bg-tint-warning px-3 py-2 text-caption text-status-warning"
                      >
                        Session {i + 1} has {forSession.toLocaleString()} tickets on sale but the
                        venue holds {venueCapacity.toLocaleString()}. Capacity is what the space
                        seats; quantity is what you put on sale. Change one of them if that is not
                        deliberate.
                      </p>
                    );
                  })}
                {tickets.map((t, i) => (
                  /*
                    One group per ticket type, named "Ticket type 2" and so on. Every row has a
                    field called "Name" and one called "Price", and the group is what tells
                    them apart - to a screen reader, and to anybody scanning a long list.
                  */
                  <fieldset
                    key={i}
                    className="grid gap-3 rounded-md border border-border p-3 sm:grid-cols-2"
                  >
                    <legend className="px-1 text-caption font-medium text-text-secondary">
                      Ticket type {i + 1}
                    </legend>
                    <Input
                      id={`tn${i}`}
                      label="Name"
                      required
                      placeholder={i === 0 ? undefined : 'e.g. VIP'}
                      value={t.name}
                      onChange={(e) =>
                        setTickets(
                          tickets.map((x, j) => (j === i ? { ...x, name: e.target.value } : x)),
                        )
                      }
                      error={fieldErrors[`t${i}Name`]}
                    />
                    {sessions.length > 1 && (
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
                          Named by when it starts, not by its index. "Session 1" identifies
                          nothing — with three showings on one day an organizer cannot tell
                          which is which. The date is the thing they actually chose.
                        */}
                        {sessions.map((sess, si) => (
                          <option key={si} value={si}>
                            {sessionWhen(sess, si)}
                          </option>
                        ))}
                      </Select>
                    )}
                    {/*
                      No price on a free event. It is not a price of zero the organizer has to
                      leave alone; it is a question that does not apply, so it is not asked.
                    */}
                    {!isFree && (
                      <Input
                        id={`tp${i}`}
                        label={`Price (${currencySymbol})`}
                        type="number"
                        inputMode="decimal"
                        min={0}
                        required
                        value={t.priceMajor}
                        hint={
                          i === 0
                            ? `In ${eventCurrency}, the currency of the venue's country.`
                            : undefined
                        }
                        error={fieldErrors[`t${i}Price`]}
                        onChange={(e) =>
                          setTickets(
                            tickets.map((x, j) =>
                              j === i ? { ...x, priceMajor: e.target.value } : x,
                            ),
                          )
                        }
                      />
                    )}
                    <Input
                      id={`tq${i}`}
                      label="Quantity on sale"
                      type="number"
                      inputMode="numeric"
                      min={1}
                      required
                      value={t.quantityTotal}
                      hint="How many of this ticket type are for sale. Not the venue's capacity."
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
                      inputMode="numeric"
                      min={1}
                      value={t.maxPerOrder}
                      hint="The most one buyer can take in one order."
                      error={fieldErrors[`t${i}Max`]}
                      onChange={(e) =>
                        setTickets(
                          tickets.map((x, j) =>
                            j === i ? { ...x, maxPerOrder: e.target.value } : x,
                          ),
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
                        Remove ticket type {i + 1}
                      </Button>
                    )}
                  </fieldset>
                ))}
                {/*
                  The running total, per session. Several ticket types make "how many people
                  am I letting in" a sum the organizer would otherwise do in their head.
                */}
                <p role="status" className="text-sm font-medium text-text-primary">
                  {sessions.length === 1
                    ? `Total on sale: ${totals[0].toLocaleString()} ticket${totals[0] === 1 ? '' : 's'}`
                    : `Total on sale: ${totals
                        .map((n, i) => `session ${i + 1}, ${n.toLocaleString()}`)
                        .join('; ')}`}
                  {venueCapacity !== null
                    ? ` (the venue holds ${venueCapacity.toLocaleString()})`
                    : ''}
                </p>
                <Button
                  variant="outline"
                  onClick={() => setTickets([...tickets, newTicketRow(tickets)])}
                >
                  + Add ticket type
                </Button>
              </div>
            )}
          </div>
        )}

        {current.id === 'details' && (
          <div className="space-y-4">
            <EventGalleryEditor
              tiles={images.map((image) => ({ key: image.key, url: image.url }))}
              busy={preparingImages}
              error={imageError}
              note={
                restoredAt !== null && images.length === 0
                  ? 'Images are not kept in a saved draft — add them again if you had some.'
                  : null
              }
              onAdd={(files) => void addImages(files)}
              onRemove={(key) =>
                setImages((current) => {
                  const gone = current.find((image) => image.key === key);
                  if (gone) URL.revokeObjectURL(gone.url);
                  return current.filter((image) => image.key !== key);
                })
              }
              onReorder={(keys) =>
                setImages((current) =>
                  keys
                    .map((key) => current.find((image) => image.key === key))
                    .filter((image): image is (typeof current)[number] => Boolean(image)),
                )
              }
            />
            <EventDetailsFields value={details} onChange={setDetails} />
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
                  {REFUND_CUTOFFS.map((c) => (
                    <option key={c.value} value={c.value}>
                      {c.label}
                    </option>
                  ))}
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
          </div>
        )}

        {current.id === 'review' && (
          <div className="space-y-5 text-sm">
            {/*
              ── EVERYTHING STILL MISSING, IN ONE PLACE ───────────────────────────────────
              The indicator lets an organizer jump around, so they can arrive here with an
              earlier step broken by a later change - a venue swapped after its seats were
              chosen. Rather than letting them press Create to find out, the list says what is
              missing, on which step, with a way straight there; Create stays off until it is
              empty.
            */}
            {outstanding.length > 0 && (
              <section
                aria-labelledby="review-missing"
                className="rounded-md border border-status-error/40 bg-tint-error p-4"
              >
                <h3 id="review-missing" className="font-semibold text-status-error">
                  Still needed before the event can be created
                </h3>
                <ul className="mt-2 space-y-3">
                  {outstanding.map((s) => (
                    <li key={s.index}>
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <span className="font-medium text-text-primary">{s.title}</span>
                        <Button variant="outline" size="sm" onClick={() => goTo(s.index)}>
                          Go to {s.title}
                        </Button>
                      </div>
                      <ul className="mt-1 list-disc space-y-0.5 pl-5 text-text-secondary">
                        {s.problems.map((problem) => (
                          <li key={problem}>{problem}</li>
                        ))}
                      </ul>
                    </li>
                  ))}
                </ul>
              </section>
            )}

            {/*
              ── WHAT THE BUYER SEES ──────────────────────────────────────────────────────
              The card as it will sit on the storefront, and the facts a buyer decides on:
              when (in the venue's clock, with its zone, because that is what the storefront
              shows), where, the lowest price, and what happens about fees. The organizer
              checks their event the way it will be read, not as a list of their own answers.
            */}
            <section aria-labelledby="review-preview" className="space-y-3">
              <h3 id="review-preview" className="font-semibold text-text-primary">
                What buyers will see
              </h3>
              <div className="grid gap-4 sm:grid-cols-2">
                <EventPreviewCard
                  seed={basics.title || 'new event'}
                  title={basics.title || 'Your event title'}
                  category={basics.category}
                  imageUrl={images[0]?.url ?? null}
                  when={previewWhen}
                  where={previewWhere}
                  price={previewPrice}
                  showFrom={previewFromMinor !== null && previewFromMinor > 0}
                />
                <dl className="space-y-2 rounded-md border border-border p-4">
                  <PreviewFact label="Event" value={basics.title || 'No title yet'} />
                  <PreviewFact
                    label={sessions.length > 1 ? 'First date' : 'Date and time'}
                    value={
                      sessions.length > 1
                        ? `${previewWhen}, and ${sessions.length - 1} more date${sessions.length === 2 ? '' : 's'}`
                        : previewWhen
                    }
                  />
                  <PreviewFact label="Venue" value={previewWhere} />
                  <PreviewFact
                    label="Price"
                    value={
                      previewFromMinor !== null && previewFromMinor > 0
                        ? `From ${previewPrice}`
                        : previewPrice
                    }
                  />
                  <PreviewFact label="Fees" value={buyerFeeNote(admission, feeMode)} />
                </dl>
              </div>
            </section>

            <ReviewSection title="Basics" onEdit={() => goTo(0)}>
              <Row label="Title" value={basics.title} />
              <Row label="Category" value={basics.category} />
              <Row label="Description" value={basics.description ? 'Added' : 'None'} />
            </ReviewSection>

            <ReviewSection title="Where and when" onEdit={() => goTo(1)}>
              <Row
                label="Venue"
                value={
                  venueMode === 'existing'
                    ? (chosenVenue?.name ?? '-')
                    : `${newVenue.name}, ${newVenue.city} (new)`
                }
              />
              <Row
                label={sessions.length === 1 ? 'Session' : `Sessions (${sessions.length})`}
                value={sessions.map((s, i) => sessionWhen(s, i)).join(', ')}
              />
            </ReviewSection>

            <ReviewSection title="Tickets and pricing" onEdit={() => goTo(2)}>
              <Row
                label="Admission"
                value={
                  admission === 'free'
                    ? 'Free - no payment taken'
                    : admission === 'paid'
                      ? 'Paid - general admission'
                      : admission === 'seated'
                        ? 'Reserved seating'
                        : 'Not chosen yet'
                }
              />
              {/*
                Seating is named here rather than counted. "2 seated" would not tell the
                organizer WHICH room, and booking a run of shows into the wrong auditorium is
                the mistake this page exists to catch — after the event is created the seats
                are already written and the session has to be removed to change it.
              */}
              {admission === 'seated' && (
                <Row
                  label="Seating"
                  value={
                    sessions.length === 1
                      ? `Assigned seats — ${roomByLayout(sessions[0].seatMapId)?.name ?? 'no seat map chosen'}`
                      : sessions
                          .map((x, i) => {
                            const room = roomByLayout(x.seatMapId);
                            return `${i + 1}: ${room ? room.name : 'no seat map chosen'}`;
                          })
                          .join(', ')
                  }
                />
              )}
              <Row
                label="Ticket types"
                value={
                  admission === 'seated'
                    ? 'From the seat map - one per seat category'
                    : sentTickets
                        .map(
                          (t) =>
                            `${t.name} (${isFree ? 'Free' : money(Math.round(Number(t.priceMajor) * 100), eventCurrency)} x ${t.quantityTotal})`,
                        )
                        .join(', ')
                }
              />
              {!isFree && (
                /*
                  Answered, and changeable. This was a whole step of the wizard; it is now a
                  default an organizer can see and override without having been stopped by it.

                  Phrased as what HAPPENS rather than as a mode name: "Customer pays fees" is
                  our vocabulary, and the organizer wants to know what the buyer is charged.
                */
                <div className="rounded-md border border-border p-4">
                  <Select
                    id="feeMode"
                    label="Who pays the booking fee?"
                    value={feeMode}
                    onChange={(e) => setFeeMode(e.target.value)}
                  >
                    {FEE_MODES.map((f) => (
                      <option key={f.value} value={f.value}>
                        {f.label}
                      </option>
                    ))}
                  </Select>
                  <p className="mt-2 text-caption text-text-muted">
                    Most organizers leave this as it is. The buyer sees every fee before they pay.
                  </p>
                </div>
              )}
            </ReviewSection>

            <ReviewSection title="Image and details" onEdit={() => goTo(3)}>
              <Row
                label="Images"
                value={images.length === 0 ? 'None' : `${images.length} — the first is the cover`}
              />
              <Row
                label="Age limit"
                value={details.ageLimit ? `${details.ageLimit}+` : 'No age limit'}
              />
              <Row
                label="Artists"
                value={
                  eventDetailsBody(details)
                    .artists.map((a) => a.name)
                    .join(', ') || 'None'
                }
              />
              <Row
                label="Terms"
                value={(() => {
                  const n = termsList(details.termsAndConditions).length;
                  return n ? `${n} term${n === 1 ? '' : 's'}` : 'None';
                })()}
              />
              <Row
                label="Refunds"
                value={
                  basics.refundsEnabled
                    ? `Allowed, closing ${(
                        REFUND_CUTOFFS.find((c) => c.value === basics.refundCutoffHours)?.label ??
                        `${basics.refundCutoffHours} hours before`
                      ).toLowerCase()}`
                    : 'Not offered to attendees'
                }
              />
            </ReviewSection>

            {/*
              ── WHAT THE TWO BUTTONS DO ─────────────────────────────────────────────────
              The last thing a first-time organizer could not answer was what would happen when
              they pressed one. Said here, from what the API actually does with each, so the
              choice between them is a choice and not a guess.
            */}
            <section
              aria-labelledby="review-next"
              className="rounded-md border border-border bg-background-subtle p-4"
            >
              <h3 id="review-next" className="font-semibold text-text-primary">
                What happens next
              </h3>
              <ul className="mt-2 list-disc space-y-1.5 pl-5 text-text-secondary">
                <li>{happens.saveDraft}</li>
                <li>{happens.submit}</li>
                <li>{happens.checks}</li>
              </ul>
            </section>
          </div>
        )}

        {error && (
          <p role="alert" className="mt-4 text-sm text-status-error">
            {error}
          </p>
        )}

        <div className="mt-6 flex flex-wrap justify-between gap-2">
          <Button variant="outline" onClick={() => goTo(step - 1)} disabled={step === 0 || busy}>
            Back
          </Button>
          {step < REVIEW_STEP ? (
            <Button onClick={() => goTo(step + 1)}>Next</Button>
          ) : (
            <div className="flex flex-wrap gap-2">
              <Button
                variant="outline"
                loading={busy}
                disabled={outstanding.length > 0}
                onClick={() => commit(false)}
              >
                Save draft
              </Button>
              <Button loading={busy} disabled={outstanding.length > 0} onClick={() => commit(true)}>
                Submit for approval
              </Button>
            </div>
          )}
        </div>
      </Card>
    </div>
  );
}

/** One step's answers on Review, with the way back to change them. */
function ReviewSection({
  title,
  onEdit,
  children,
}: {
  title: string;
  onEdit: () => void;
  children: ReactNode;
}) {
  return (
    <section className="space-y-2">
      <div className="flex items-center justify-between gap-3">
        <h3 className="font-semibold text-text-primary">{title}</h3>
        <Button variant="ghost" size="sm" onClick={onEdit} aria-label={`Edit ${title}`}>
          Edit
        </Button>
      </div>
      <div className="space-y-2">{children}</div>
    </section>
  );
}

/** One fact in the "what buyers will see" panel. */
function PreviewFact({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className="text-caption text-text-muted">{label}</dt>
      <dd className="font-medium text-text-primary">{value}</dd>
    </div>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex justify-between gap-4 border-b border-border pb-2">
      <span className="text-text-muted">{label}</span>
      <span className="min-w-0 break-words text-right font-medium text-text-primary">
        {value || '—'}
      </span>
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
