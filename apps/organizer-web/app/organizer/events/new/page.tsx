'use client';

import { useQuery } from '@tanstack/react-query';
import { useRouter, useSearchParams } from 'next/navigation';
import { Suspense, useEffect, useRef, useState, type FocusEvent, type ReactNode } from 'react';
import {
  ArrowLeft,
  ArrowRight,
  Armchair,
  CircleAlert,
  CircleCheck,
  Gift,
  Plus,
  Save,
  Ticket,
  Trash2,
} from 'lucide-react';
import {
  api,
  addDays,
  Button,
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
  join,
  split,
  zoneAbbrev,
  CENTRE_FOCAL_POINT,
  type FocalPoint,
  type LocationValue,
} from '@eticketsgo/web-kit';
import { venuePayload } from '@/components/venue-fields';
import { useOrg } from '@/components/org-context';
import { venueInputZone, wallClockToInstant, zoneLabel } from '@/lib/zoned-time';
import { getTemplate } from '@/lib/templates';
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
import {
  EXPERIENCES,
  TEMPLATE_EXPERIENCE,
  categoryForExperience,
  experienceForCategory,
  getExperience,
  type ExperienceId,
} from '@/components/create-event/experiences';
import { ExperiencePicker } from '@/components/create-event/experience-picker';
import { CinemaRoute } from '@/components/create-event/cinema-route';
import { CreateSteps } from '@/components/create-event/create-steps';
import { VenuePicker } from '@/components/create-event/venue-picker';
import { BuyerPreview, type PreviewImage } from '@/components/create-event/buyer-preview';
import { CoverFocus } from '@/components/create-event/cover-focus';

/*
  ── START FROM WHAT THEY ARE ORGANIZING, THEN ADAPT ────────────────────────────────
  Owner's verdict on the previous version (3/10): "a form-heavy experience with excessive empty
  space". It asked every organizer the same five pages of questions in the same words, in a
  narrow column with nothing beside it, and showed what buyers would see only at the very end.

  Now:
  - The first screen asks what kind of event it is, as seven cards. A film goes to the cinema
    workflow instead (see CinemaRoute); every other choice runs the same steps with its own
    words, examples, defaults and category choices (components/create-event/experiences).
  - On a wide screen the right-hand column shows the event as buyers will see it, updating as
    the organizer types, and what is still needed. On a phone the actions sit in a bar at the
    bottom of the screen.
  - Every step has Save draft, and the draft is also saved on every change, as before.
  - Problems are pointed out when a field is left or Continue is pressed, not listed before
    the organizer has typed anything.

  What is SENT is unchanged: the same venue, event, session, ticket type, image and submit
  calls, in the same order, with the same values. The rules for each step are in
  `lib/event-wizard`, where they are tested. The experience changes words and defaults only.
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
function sessionWhen(s: SessionDraft, index: number, noun: string): string {
  return s.startsAt
    ? // Formatted as typed - a wall clock at the venue - so read in UTC, where it is unshifted.
      new Date(`${s.startsAt}:00Z`).toLocaleString('en-IN', {
        timeZone: 'UTC',
        day: 'numeric',
        month: 'short',
        hour: 'numeric',
        minute: '2-digit',
      })
    : `${noun} ${index + 1} - no time set`;
}

/** The same times a day later: the usual second night of a run, one click instead of four. */
function dayLater(value: string): string {
  const { date, time } = split(value);
  return date ? join(addDays(date, 1), time) : '';
}

interface WizardImage {
  key: string;
  blob: Blob;
  url: string;
  width: number;
  height: number;
}

/** The picture's own size, for crop arithmetic. 0x0 when it cannot be read (the crop then centres). */
function imageSize(url: string): Promise<{ width: number; height: number }> {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => resolve({ width: img.naturalWidth, height: img.naturalHeight });
    img.onerror = () => resolve({ width: 0, height: 0 });
    img.src = url;
  });
}

function NewEventWizard() {
  const { activeOrg } = useOrg();
  const router = useRouter();
  const toast = useToast();
  // Optional starter template deep-linked from onboarding (?template=concert, ...). It seeds
  // the experience and the first answers; the organizer can change all of them.
  const searchParams = useSearchParams();
  const template = getTemplate(searchParams.get('template'));
  const templateExperience = template ? TEMPLATE_EXPERIENCE[template.id] : undefined;
  const [step, setStep] = useState(0);
  /*
    The furthest step reached. Every step up to it can be jumped to from the indicator, and is
    shown as complete or as needing attention; the ones after it have not been asked yet.
  */
  const [furthest, setFurthest] = useState(0);
  const [error, setError] = useState<string | null>(null);
  /* Which problems on the current step have been pointed out. Shown with their LIVE message. */
  const [shownErrors, setShownErrors] = useState<FieldErrors>({});
  /* Whether Continue was refused on this step, which is when the summary of problems shows. */
  const [refused, setRefused] = useState(false);
  const [busy, setBusy] = useState(false);

  const venuesQ = useQuery({
    queryKey: ['venues', activeOrg.id],
    queryFn: () => api.venues.list(activeOrg.id),
  });
  /*
    The rooms with a published seat map, fetched up front so the tickets step can offer
    reserved seating without a spinner in the middle of the form. Answered by the server: it is
    the same rule the create call enforces.
  */
  const roomsQ = useQuery({
    queryKey: ['seating-rooms', activeOrg.id],
    queryFn: () => api.events.seatingRooms(activeOrg.id),
  });

  /*
    The form as it opens, from one definition in `lib/event-wizard` - the same one that decides
    whether a saved draft has anything in it. A film template opens the first screen with the
    film chosen rather than the form, because films are not scheduled here.
  */
  const [initial] = useState(() => {
    const exp =
      templateExperience && templateExperience !== 'movie'
        ? getExperience(templateExperience)
        : undefined;
    return initialWizardDraft({
      experience: exp?.id,
      ticketName: exp?.defaultTicketName,
      title: exp ? template?.suggestedTitle : undefined,
      category: exp ? template?.category : undefined,
      description: exp ? template?.description : undefined,
    });
  });
  const [experienceId, setExperienceId] = useState<ExperienceId | ''>(
    (getExperience(initial.experience)?.id ?? '') as ExperienceId | '',
  );
  /* The card selected on the first screen, before Continue. */
  const [picked, setPicked] = useState<ExperienceId | ''>(templateExperience ?? experienceId ?? '');
  const [pickError, setPickError] = useState(false);
  const experience = getExperience(experienceId);
  const inFlow = Boolean(experience && !experience.routesToCinema);
  const nouns = {
    session: experience?.sessionNoun ?? 'Session',
    ticket: experience?.ticketNoun ?? 'Ticket type',
  };
  const stepTitles = WIZARD_STEPS.map((s) => ({
    ...s,
    title: s.id === 'tickets' && nouns.ticket === 'Pass' ? 'Passes' : s.title,
  }));

  const [basics, setBasics] = useState(initial.basics);
  const [details, setDetails] = useState<EventDetailsValue>(EMPTY_EVENT_DETAILS);
  /* Whether the category is being picked or typed. */
  const [categoryMode, setCategoryMode] = useState<'list' | 'other'>(initial.categoryMode);
  /*
    How people get in: free, paid general admission or reserved seating.

    Free is declared rather than inferred from the prices. Deriving it would make the event
    flip between free and paid as somebody edited a number, and free is not a price - it
    changes what the platform DOES. No payment provider is called, no booking fee and no
    platform share are taken, and the buyer never sees a checkout.
  */
  const [admission, setAdmission] = useState<Admission>(initial.admission);
  const isFree = isFreeAdmission(admission);
  const [venueMode, setVenueMode] = useState<'existing' | 'new'>(initial.venueMode);
  const [venueId, setVenueId] = useState(initial.venueId);
  const [newVenue, setNewVenue] = useState(initial.newVenue);
  // Same three interdependent answers as the venues page, from the same component.
  const [newVenueWhere, setNewVenueWhere] = useState<LocationValue>(defaultLocation);
  const [feeMode, setFeeMode] = useState(initial.feeMode);

  /*
    An organization with no venues yet starts on "New venue": the saved-venue list would be an
    empty box with nothing to choose. Only before the organizer has chosen either themselves.
  */
  const venueModeTouched = useRef(false);
  useEffect(() => {
    if (venuesQ.data && venuesQ.data.length === 0 && !venueModeTouched.current) {
      setVenueMode('new');
    }
  }, [venuesQ.data]);

  /*
    Currency follows the VENUE: where the event is held decides what the buyer is charged and
    which tax rules apply. The price label names it, so 499 typed for a show in Boise is not
    read as rupees.
  */
  const chosenVenue = venuesQ.data?.find((v) => v.id === venueId);
  /* What the room holds, if anybody has said. A fact about the building, not a ticket count. */
  const venueCapacity =
    venueMode === 'new'
      ? newVenue.capacity
        ? Number(newVenue.capacity)
        : null
      : (chosenVenue?.capacity ?? null);
  const eventCountry = venueMode === 'new' ? newVenueWhere.country : chosenVenue?.country;
  const eventCurrency = currencyForCountry(eventCountry) ?? 'INR';
  /* Symbol only - the field holds a plain number, so a formatted amount would be misleading. */
  const currencySymbol =
    new Intl.NumberFormat(undefined, { style: 'currency', currency: eventCurrency })
      .formatToParts(0)
      .find((p) => p.type === 'currency')?.value ?? eventCurrency;
  /*
    The zone the organizer is typing show times in: the venue's, never the browser's. See
    lib/zoned-time.ts - a 19:00 Hyderabad concert typed from Denver used to be stored as
    19:00 Denver time.
  */
  const inputZone = venueInputZone(
    venueMode === 'new'
      ? { timezone: newVenueWhere.timezone, country: newVenueWhere.country }
      : chosenVenue,
  );
  const eventTimezone = inputZone.known ? inputZone.zone : undefined;
  const timeZoneNote = inputZone.known
    ? `Venue time: ${zoneLabel(inputZone.zone)}`
    : `Your time zone (${inputZone.zone}) - choose the venue to be sure`;
  const [sessions, setSessions] = useState<SessionDraft[]>(initial.sessions);
  const [tickets, setTickets] = useState<TicketDraft[]>(initial.tickets);

  /*
    ── THE DRAFT SURVIVES LEAVING THIS PAGE ──────────────────────────────────────────
    Saved on every change and restored on return, with the organizer told it happened. Cleared
    the moment a real event exists, so a finished wizard never offers to restore itself.
  */
  const draftState: WizardDraft = {
    experience: experienceId,
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
    Set once a draft has been considered, so the first render cannot save over it. State, not
    a ref: a ref flipped inside the restore effect was already true when the save effect ran in
    the SAME commit, with that render's still-empty answers.
  */
  const [hydrated, setHydrated] = useState(false);
  /* Set once the event really exists, so nothing can write the draft back. */
  const committed = useRef(false);
  /* When the draft was last written, for the "Saved" line. Changes only when the answers do. */
  const lastSaved = useRef<{ json: string; at: number } | null>(null);
  const [, setTick] = useState(0);
  useEffect(() => {
    const id = window.setInterval(() => setTick((n) => n + 1), 20_000);
    return () => window.clearInterval(id);
  }, []);
  /* Said once, out loud, when Save draft is pressed. */
  const [savedNotice, setSavedNotice] = useState<string | null>(null);

  /*
    The images, already resized and in the organizer's order, held until the event exists to
    attach them to. The first is the cover. Not in the saved draft: the draft is localStorage,
    and images would crowd out the answers it exists to protect.
  */
  const [images, setImages] = useState<WizardImage[]>([]);
  /* Where each picture is cropped around, by image key. Only the cover's is sent. */
  const [focal, setFocal] = useState<Record<string, FocalPoint>>({});
  const [imageError, setImageError] = useState<string | null>(null);
  const [preparingImages, setPreparingImages] = useState(false);
  const imagesRef = useRef(images);
  imagesRef.current = images;
  useEffect(() => () => imagesRef.current.forEach((image) => URL.revokeObjectURL(image.url)), []);

  const addImages = async (files: File[]) => {
    setImageError(null);
    setPreparingImages(true);
    const room = EVENT_IMAGE_MAX_COUNT - imagesRef.current.length;
    const prepared: WizardImage[] = [];
    let problem: string | null =
      files.length > room
        ? `Only ${EVENT_IMAGE_MAX_COUNT} images fit. The first ${Math.max(room, 0)} were added.`
        : null;
    for (const file of files.slice(0, Math.max(room, 0))) {
      try {
        const blob = await prepareEventImage(file);
        const url = URL.createObjectURL(blob);
        prepared.push({ key: crypto.randomUUID(), blob, url, ...(await imageSize(url)) });
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
    /* A draft with nothing the organizer entered is thrown away without a word. */
    if (!isMeaningfulDraft(d, initial)) {
      clearEventDraft(activeOrg.id);
      return;
    }
    /*
      The experience, or - for a draft saved before the first question existed - the one its
      category belongs to. A typed category belongs to "Community or other", where typing one
      is offered.
    */
    const exp =
      getExperience(d.experience) ??
      getExperience(
        d.categoryMode === 'other' && d.basics.category
          ? 'community'
          : experienceForCategory(d.basics.category),
      );
    setExperienceId(exp && !exp.routesToCinema ? exp.id : '');
    setPicked(exp?.id ?? '');
    setStep(d.step);
    setFurthest(d.furthest);
    setBasics(d.basics);
    setDetails(d.details);
    setCategoryMode(d.categoryMode);
    setAdmission(d.admission);
    venueModeTouched.current = true;
    setVenueMode(d.venueMode);
    setVenueId(d.venueId);
    setNewVenue(d.newVenue);
    setNewVenueWhere(d.newVenueWhere ?? defaultLocation);
    setFeeMode(d.feeMode);
    setSessions(d.sessions);
    setTickets(d.tickets);
    setRestoredAt(found.savedAt);
    lastSaved.current = { json: JSON.stringify(d), at: found.savedAt };
    // Runs for the organization, not for the draft: re-reading on every keystroke would fight
    // the person typing.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeOrg.id]);

  useEffect(() => {
    // Never before the restore has had its turn, or an empty form overwrites a real draft.
    // Never after the event exists, or a finished event is offered back as a draft.
    if (!hydrated || committed.current) return;
    /* A form with nothing entered is not saved - that produced a false "Picked up". */
    if (isMeaningfulDraft(draftState, initial)) {
      saveEventDraft(activeOrg.id, draftState);
      const json = JSON.stringify({ ...draftState, step: 0 });
      if (lastSaved.current?.json !== json) lastSaved.current = { json, at: Date.now() };
    } else {
      clearEventDraft(activeOrg.id);
      lastSaved.current = null;
    }
  });

  /* Save draft, on every step: written now, and said so. */
  const saveDraftNow = () => {
    if (!isMeaningfulDraft(draftState, initial)) {
      setSavedNotice('Nothing to save yet. Add a title first.');
      return;
    }
    saveEventDraft(activeOrg.id, draftState);
    lastSaved.current = { json: JSON.stringify({ ...draftState, step: 0 }), at: Date.now() };
    setSavedNotice(
      'Draft saved on this device. Open Create event again to carry on where you stopped.',
    );
  };

  /*
    The seat maps that can be used at THIS venue. A venue being created here has no spaces
    yet, so it has none.
  */
  const venueRooms =
    venueMode === 'existing' && venueId
      ? (roomsQ.data ?? []).filter((r) => r.venueId === venueId)
      : [];
  /* Null while the list is loading or failed: nothing can be judged against an unknown list. */
  const venueSeatMaps = roomsQ.data ? venueRooms.map((r) => r.layoutId) : null;
  const seatingAvailable = venueRooms.length > 0;
  const roomByLayout = (seatMapId: string) => roomsQ.data?.find((r) => r.layoutId === seatMapId);
  const seatMapVenueIds = new Set(
    (roomsQ.data ?? []).map((r) => r.venueId).filter((id): id is string => Boolean(id)),
  );

  /* Every step's problems, from the answers as they are now. */
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
    The errors on screen: the ones already pointed out (by leaving the field or by a refused
    Continue), with today's wording, and only while they are still true.
  */
  const liveErrors = errorsByStep[WIZARD_STEPS[step].id];
  const fieldErrors: FieldErrors = Object.fromEntries(
    Object.keys(shownErrors)
      .filter((key) => key in liveErrors)
      .map((key) => [key, liveErrors[key]]),
  );
  /* Point out one field's problem once the organizer has left it. */
  const reveal = (key: string) =>
    setShownErrors((s) => (key in s ? s : { ...s, [key]: liveErrors[key] ?? '' }));
  /* For a group of controls: only when focus leaves the whole group. */
  const revealOnLeave = (key: string) => (e: FocusEvent<HTMLElement>) => {
    if (e.relatedTarget instanceof Node && e.currentTarget.contains(e.relatedTarget)) return;
    reveal(key);
  };

  /*
    ── WHERE THE CURSOR GOES ────────────────────────────────────────────────────────
    A new step puts focus on its heading, so a screen reader announces where the organizer has
    arrived. A refused step puts focus in the first field that is wrong.
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
  }, [step, focusRequest, inFlow]);

  /** Stop on a step and show what is wrong with it. */
  const showProblems = (index: number, errs: FieldErrors) => {
    setStep(index);
    setShownErrors(errs);
    setRefused(true);
    setError(errs.form ?? null);
    pendingFocus.current = firstInvalidFieldId(errs, categoryMode);
    setFocusRequest((n) => n + 1);
  };

  /*
    Every move between steps, from Back, Continue or the indicator. Backwards is always
    allowed. Forwards checks each step being passed over, in order, and stops on the first one
    with a problem, so Continue and the indicator never disagree about what is required.
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
    setRefused(false);
    setSavedNotice(null);
    // Arriving at a step already flagged shows its problems at once - that is why they came.
    const errs = statuses[target] === 'error' ? errorsByStep[WIZARD_STEPS[target].id] : {};
    setShownErrors(errs);
    if (errs.form) setError(errs.form);
    window.scrollTo({ top: 0 });
  };

  /*
    Start the steps for the chosen experience. Only words and defaults change: the category
    becomes the experience's first (or the one already picked, if it belongs), and an untouched
    first ticket row takes the experience's name for it ("Standard pass" for a conference).
  */
  const startExperience = (id: ExperienceId | '') => {
    const exp = getExperience(id);
    if (!exp) {
      setPickError(true);
      pendingFocus.current = 'experience';
      setFocusRequest((n) => n + 1);
      return;
    }
    if (exp.routesToCinema) return;
    const keepTyped = categoryMode === 'other' && exp.allowOther;
    if (!keepTyped) {
      setCategoryMode('list');
      setBasics((b) => ({ ...b, category: categoryForExperience(exp, b.category) }));
    }
    const defaults = new Set(EXPERIENCES.map((e) => e.defaultTicketName));
    setTickets((rows) =>
      rows.length === 1 && defaults.has(rows[0].name)
        ? [{ ...rows[0], name: exp.defaultTicketName }]
        : rows,
    );
    setExperienceId(exp.id);
    setPickError(false);
    setStep(0);
    setShownErrors({});
    setRefused(false);
    window.scrollTo({ top: 0 });
  };

  /*
    Answer "how do people get in". Choosing reserved seating fills in the seat map wherever
    there is only one to choose. Choosing free or paid leaves the seat choices where they are:
    nothing is sent with them (`sessionsToSend`).
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

  const orgReadinessQ = useQuery({
    queryKey: ['org-readiness', activeOrg.id],
    queryFn: () => api.organizations.readiness(activeOrg.id),
    enabled: inFlow && step === REVIEW_STEP,
  });

  const commit = async (submitForReview: boolean) => {
    /* Checked again, all of it: an earlier answer may have changed since it was passed. */
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
      this page with a button that creates the event AGAIN.
    */
    let createdId: string | null = null;
    try {
      let finalVenueId = venueId;
      if (venueMode === 'new') {
        /* ONE payload, shared with /organizer/venues and onboarding. */
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
          startsAt: wallClockToInstant(s.startsAt, inputZone.zone).toISOString(),
          endsAt: wallClockToInstant(s.endsAt, inputZone.zone).toISOString(),
          // Omitted rather than sent empty: '' is a room id that does not exist.
          ...(s.screenId ? { screenId: s.screenId } : {}),
          ...(s.seatMapId ? { seatMapId: s.seatMapId } : {}),
        });
        sessionIds.push(created.id);
      }
      /*
        Seated sessions are skipped. Their ticket types already exist - created from the room's
        seat categories - and adding more here would put two competing prices on the same night.
      */
      for (const t of ticketsToSend({ admission, sessions, tickets })) {
        await api.events.addTicketType({
          eventSessionId: sessionIds[t.sessionIndex] ?? sessionIds[0],
          name: t.name,
          // Zero regardless of what the price box holds: a free event's ticket types must all
          // be zero and the API refuses anything else.
          priceMinor: isFree ? 0 : Math.round(Number(t.priceMajor) * 100),
          quantityTotal: Number(t.quantityTotal),
          maxPerOrder: Number(t.maxPerOrder) || 10,
        });
      }
      /*
        Attached before submitting, in the organizer's order, so the first uploaded is the
        cover. Then the cover's focus point, with the same call the edit page uses. A failed
        upload does not undo an event that now exists; the organizer is told.
      */
      let imageFailed: string | null = null;
      let imagesFailed = 0;
      for (const [index, image] of images.entries()) {
        try {
          const gallery = await api.events.addImage(event.id, image.blob);
          const point = focal[image.key];
          const coverId = gallery.images[0]?.id;
          if (
            index === 0 &&
            coverId &&
            point &&
            (point.x !== CENTRE_FOCAL_POINT.x || point.y !== CENTRE_FOCAL_POINT.y)
          ) {
            await api.events.setImageFocalPoint(event.id, coverId, point);
          }
        } catch (err) {
          imagesFailed += 1;
          imageFailed = errorMessage(err);
        }
      }
      /*
        A refused submission leaves a complete DRAFT, not a failed creation. Staying here with
        the error would invite a second press that creates the whole event a second time.
      */
      let submitRefused: string | null = null;
      if (submitForReview) {
        try {
          await api.events.submit(event.id);
        } catch (err) {
          submitRefused = errorMessage(err);
        }
      }
      // Stop saving FIRST - the toast below re-renders this page, and that render would
      // write the draft back.
      committed.current = true;
      clearEventDraft();
      if (submitRefused) {
        toast.push(
          `Your event was saved as a draft, but it could not be submitted yet: ${submitRefused}`,
          'error',
        );
      } else {
        toast.push(
          submitForReview
            ? happens.submitStatus === 'Published'
              ? 'Event submitted and published.'
              : 'Event submitted for review.'
            : 'Draft event created.',
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
  const submitLabel =
    happens.submitStatus === 'Published' ? 'Submit and publish' : 'Submit for approval';
  const current = stepTitles[step];
  const sentTickets = ticketsToSend({ admission, sessions, tickets });
  const refusedProblems = refused ? describeProblems(fieldErrors, nouns) : [];
  /* Every step that still needs something. Create is disabled until it is empty. */
  const outstanding = stepTitles
    .map((s, index) => ({
      index,
      title: s.title,
      problems: describeProblems(errorsByStep[s.id], nouns),
    }))
    .filter((s) => s.problems.length > 0);
  const thingsToSetUp = outstanding.reduce((n, s) => n + s.problems.length, 0);
  const totals = capacityBySession({ admission, sessions, tickets });

  /* The preview: the facts a buyer decides on, as the storefront will show them. */
  // Only complete times: a date picked before its time is not a moment yet.
  const firstStartMs = sessions
    .map((s) =>
      s.startsAt && split(s.startsAt).time
        ? wallClockToInstant(s.startsAt, inputZone.zone).getTime()
        : NaN,
    )
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
        ? `${newVenue.name}${newVenue.city ? `, ${newVenue.city}` : ''}`
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
  const cover = images[0];
  const previewImage: PreviewImage | null = cover
    ? {
        url: cover.url,
        width: cover.width,
        height: cover.height,
        focal: focal[cover.key] ?? CENTRE_FOCAL_POINT,
      }
    : null;
  const preview = (
    <BuyerPreview
      icon={experience?.icon ?? Ticket}
      title={basics.title || 'Your event title'}
      category={basics.category}
      image={previewImage}
      when={
        sessions.length > 1 && firstStartIso
          ? `${previewWhen} +${sessions.length - 1} more`
          : previewWhen
      }
      where={previewWhere}
      organizer={activeOrg.name}
      price={previewPrice}
      showFrom={previewFromMinor !== null && previewFromMinor > 0}
    />
  );

  const savedAt = lastSaved.current?.at ?? null;
  const saveStatus =
    savedAt !== null ? (
      <span className="inline-flex items-center gap-1.5 text-caption text-text-muted">
        <CircleCheck aria-hidden="true" className="h-3.5 w-3.5 text-status-success" />
        Draft saved on this device {draftAge(savedAt)}
      </span>
    ) : null;

  /* ── THE FIRST SCREEN: WHAT ARE YOU ORGANIZING? ───────────────────────────────── */
  if (!inFlow) {
    return (
      <div className="mx-auto max-w-5xl pb-28">
        <PageHeader
          title="Create your event"
          description="Pick the kind of event. We only ask what that kind of event needs, and you can change it later."
          breadcrumbs={[{ label: 'Events', href: '/organizer/events' }, { label: 'New' }]}
        />
        <div className="space-y-5">
          <ExperiencePicker
            value={picked}
            onChange={(id) => {
              setPicked(id);
              setPickError(false);
            }}
          />
          {pickError ? (
            <p role="alert" className="text-caption text-status-error">
              Choose the kind of event you are organizing to continue.
            </p>
          ) : null}
          {picked === 'movie' ? <CinemaRoute organizationId={activeOrg.id} /> : null}
        </div>
        {picked !== 'movie' ? (
          <ActionBar>
            <span className="hidden text-caption text-text-muted sm:block">
              {picked
                ? `Next: the basics of your ${getExperience(picked)?.label.toLowerCase()}.`
                : 'Choose one to continue.'}
            </span>
            <Button onClick={() => startExperience(picked)} className="ml-auto">
              Continue{' '}
              <ArrowRight aria-hidden="true" className="hidden h-4 w-4 min-[360px]:inline" />
            </Button>
          </ActionBar>
        ) : null}
      </div>
    );
  }

  const exp = experience!;
  const ExpIcon = exp.icon;
  const intro =
    current.id === 'where'
      ? `The venue, and the date and time of each ${nouns.session.toLowerCase()}.`
      : current.id === 'tickets' && nouns.ticket === 'Pass'
        ? 'How people register: free, paid passes, or reserved seats.'
        : current.intro;

  return (
    <div className="mx-auto max-w-6xl pb-6">
      <PageHeader
        title="Create event"
        eyebrow={exp.label}
        breadcrumbs={[{ label: 'Events', href: '/organizer/events' }, { label: 'New' }]}
        action={saveStatus}
      />

      <div className="xl:grid xl:grid-cols-[minmax(0,44rem)_20rem] xl:items-start xl:justify-center xl:gap-8">
        <div className="min-w-0 space-y-5">
          <CreateSteps
            steps={stepTitles}
            current={step}
            statuses={statuses}
            canVisit={(i) => canVisitStep(i, furthest)}
            onVisit={goTo}
          />

          {/*
            Say that the form was refilled. Silently restoring somebody's work is nearly as
            disorienting as losing it; saying where the answers came from, and offering to throw
            them away, turns a surprise into a choice.
          */}
          {restoredAt !== null && (
            <div className="flex flex-wrap items-center justify-between gap-3 rounded-md border border-border bg-background-surface px-4 py-2.5">
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

          <section
            aria-labelledby="step-heading"
            className="rounded-lg border border-border bg-background-surface p-4 sm:p-6"
          >
            <div className="mb-5">
              <h2
                id="step-heading"
                ref={headingRef}
                tabIndex={-1}
                className="text-xl font-semibold tracking-tight text-text-primary focus:outline-none"
              >
                {current.title}
              </h2>
              <p className="mt-1 text-sm text-text-secondary">{intro}</p>
              <p className="mt-1 text-caption text-text-muted">{current.required}</p>
              {/*
                What is wrong, in one list, after Continue was refused. Not before: listing
                "Title must be at least 3 characters" over an empty form told a new organizer
                they had made mistakes before they had typed anything.
              */}
              {refusedProblems.length > 0 ? (
                <div
                  role="alert"
                  className="mt-3 rounded-md border border-status-error/40 bg-tint-error px-3 py-2 text-caption"
                >
                  <p className="font-semibold text-status-error">
                    {refusedProblems.length === 1
                      ? '1 thing to fix before you continue'
                      : `${refusedProblems.length} things to fix before you continue`}
                  </p>
                  <ul className="mt-1 list-disc space-y-0.5 pl-5 text-text-primary">
                    {refusedProblems.map((p) => (
                      <li key={p}>{p}</li>
                    ))}
                  </ul>
                </div>
              ) : null}
            </div>

            {current.id === 'basics' && (
              <div className="space-y-5">
                <div className="flex flex-wrap items-center justify-between gap-2 rounded-md bg-background-subtle px-3 py-2">
                  <span className="inline-flex items-center gap-2 text-sm text-text-primary">
                    <ExpIcon aria-hidden="true" className="h-4 w-4 text-action-primary" />
                    <span>
                      <span className="sr-only">Kind of event: </span>
                      {exp.label}
                    </span>
                  </span>
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => {
                      setPicked(exp.id);
                      setExperienceId('');
                    }}
                  >
                    Change kind of event
                  </Button>
                </div>

                <Input
                  id="title"
                  label="Event title"
                  required
                  placeholder={exp.titleExample}
                  value={basics.title}
                  onChange={(e) => setBasics({ ...basics, title: e.target.value })}
                  onBlur={() => reveal('title')}
                  error={fieldErrors.title}
                />

                {/*
                  The category, from this experience's few - shown as choices, with the first
                  already picked. Browse builds its category list from this column, so a list
                  keeps it tidy; "Something else" stays where it belongs.
                */}
                {exp.categories.length > 1 || exp.allowOther ? (
                  <fieldset>
                    <legend className="mb-1.5 text-[0.8125rem] font-medium text-text-secondary">
                      Category
                    </legend>
                    <div className="flex flex-wrap gap-2">
                      {[...exp.categories, ...(exp.allowOther ? ['__other'] : [])].map((c, i) => {
                        const checked =
                          c === '__other'
                            ? categoryMode === 'other'
                            : categoryMode === 'list' && basics.category === c;
                        return (
                          <label
                            key={c}
                            className={`relative inline-flex min-h-10 cursor-pointer items-center rounded-full border px-4 text-sm font-medium transition-colors focus-within:ring-2 focus-within:ring-action-primary focus-within:ring-offset-1 ${
                              checked
                                ? 'border-action-primary bg-tint-primary text-text-primary'
                                : 'border-border-input bg-background-surface text-text-secondary hover:bg-background-subtle'
                            }`}
                          >
                            <input
                              type="radio"
                              name="category"
                              id={i === 0 ? 'category' : undefined}
                              className="absolute inset-0 m-0 cursor-pointer appearance-none rounded-full opacity-0"
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
                    ) : (
                      <p className="mt-1.5 text-caption text-text-muted">
                        Where buyers find it when they browse.
                      </p>
                    )}
                  </fieldset>
                ) : null}

                {categoryMode === 'other' && (
                  <Input
                    id="category-other"
                    label="Your category"
                    required
                    placeholder="e.g. Poetry reading"
                    value={basics.category}
                    onChange={(e) => setBasics({ ...basics, category: e.target.value })}
                    onBlur={() => reveal('category')}
                    error={fieldErrors.category}
                  />
                )}
                <Textarea
                  id="desc"
                  label="Description"
                  rows={4}
                  placeholder={exp.descriptionExample}
                  hint="Optional. What buyers read on the event page."
                  value={basics.description}
                  onChange={(e) => setBasics({ ...basics, description: e.target.value })}
                />
              </div>
            )}

            {current.id === 'where' && (
              <div className="space-y-6">
                <section aria-labelledby="where-venue" className="space-y-3">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <h3 id="where-venue" className="text-sm font-semibold text-text-primary">
                      Where
                    </h3>
                    <div
                      role="radiogroup"
                      aria-label="Venue source"
                      className="inline-flex rounded-md border border-border bg-background-subtle p-1"
                    >
                      {(
                        [
                          ['existing', 'Saved venue'],
                          ['new', 'New venue'],
                        ] as const
                      ).map(([mode, label]) => (
                        <button
                          key={mode}
                          type="button"
                          role="radio"
                          aria-checked={venueMode === mode}
                          onClick={() => {
                            venueModeTouched.current = true;
                            setVenueMode(mode);
                          }}
                          className={`rounded-sm px-3 py-1.5 text-caption font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-action-primary ${
                            venueMode === mode
                              ? 'bg-background-surface text-text-primary shadow-xs'
                              : 'text-text-secondary hover:text-text-primary'
                          }`}
                        >
                          {label}
                        </button>
                      ))}
                    </div>
                  </div>
                  {venueMode === 'existing' ? (
                    venuesQ.isLoading ? (
                      <Skeleton className="h-28 w-full" />
                    ) : (venuesQ.data ?? []).length === 0 ? (
                      <p className="text-caption text-text-muted">
                        You have no saved venues yet. Choose New venue to add one.
                      </p>
                    ) : (
                      <VenuePicker
                        venues={venuesQ.data ?? []}
                        seatMapVenueIds={seatMapVenueIds}
                        value={venueId}
                        onChange={setVenueId}
                        onBlur={() => reveal('venueId')}
                        error={fieldErrors.venueId}
                      />
                    )
                  ) : (
                    <div className="space-y-3">
                      <div className="grid gap-3 sm:grid-cols-2">
                        <Input
                          id="vname"
                          label="Venue name"
                          required
                          placeholder="e.g. The Blue Room"
                          value={newVenue.name}
                          onChange={(e) => setNewVenue({ ...newVenue, name: e.target.value })}
                          onBlur={() => reveal('venueName')}
                          error={fieldErrors.venueName}
                        />
                        <Input
                          id="vcity"
                          label="City"
                          required
                          value={newVenue.city}
                          onChange={(e) => setNewVenue({ ...newVenue, city: e.target.value })}
                          onBlur={() => reveal('venueCity')}
                          error={fieldErrors.venueCity}
                        />
                      </div>
                      <LocationFields
                        idPrefix="newvenue"
                        value={newVenueWhere}
                        onChange={setNewVenueWhere}
                        countryHint="Sets the currency you sell in and the tax rules that apply."
                      />
                      <div className="grid gap-3 sm:grid-cols-2">
                        <Input
                          id="vaddress"
                          label="Street address"
                          hint="Optional. Just the street and area."
                          value={newVenue.address}
                          onChange={(e) => setNewVenue({ ...newVenue, address: e.target.value })}
                        />
                        <Input
                          id="vcap"
                          label="Venue capacity"
                          type="number"
                          inputMode="numeric"
                          value={newVenue.capacity}
                          /*
                            A fact about the building, not how many tickets are sold - that is
                            the next step's question and a different number.
                          */
                          hint="Optional. How many people the space holds, not tickets on sale."
                          onChange={(e) => setNewVenue({ ...newVenue, capacity: e.target.value })}
                        />
                      </div>
                    </div>
                  )}
                </section>

                <section aria-labelledby="where-when" className="space-y-3">
                  <h3 id="where-when" className="text-sm font-semibold text-text-primary">
                    When
                  </h3>
                  <p className="text-caption text-text-muted">
                    {sessions.length === 1
                      ? `One date for now. For a run of dates, add another ${nouns.session.toLowerCase()} below - it is still one event.`
                      : `${sessions.length} ${nouns.session.toLowerCase()}s, one event.`}{' '}
                    Times are at the venue.
                  </p>
                  {sessions.map((s, i) => (
                    <fieldset key={i} className="rounded-md border border-border p-3 sm:p-4">
                      <legend className="px-1 text-caption font-semibold text-text-secondary">
                        {nouns.session} {i + 1}
                      </legend>
                      <div className="grid gap-4 sm:grid-cols-2">
                        <div onBlur={revealOnLeave(`s${i}Start`)}>
                          <DateTimeField
                            id={`ss${i}`}
                            label="Starts at"
                            value={s.startsAt}
                            onChange={(v) =>
                              setSessions(
                                sessions.map((x, j) => (j === i ? { ...x, startsAt: v } : x)),
                              )
                            }
                            error={fieldErrors[`s${i}Start`]}
                            timeZoneLabel={timeZoneNote}
                          />
                        </div>
                        <div onBlur={revealOnLeave(`s${i}End`)}>
                          <DateTimeField
                            id={`se${i}`}
                            label="Ends at"
                            value={s.endsAt}
                            // Anchored to the start, so the shortcuts read "+2h".
                            relativeTo={s.startsAt}
                            min={s.startsAt}
                            onChange={(v) =>
                              setSessions(
                                sessions.map((x, j) => (j === i ? { ...x, endsAt: v } : x)),
                              )
                            }
                            error={fieldErrors[`s${i}End`]}
                            timeZoneLabel={timeZoneNote}
                          />
                        </div>
                      </div>
                      {sessions.length > 1 && (
                        <Button
                          variant="ghost"
                          size="sm"
                          className="mt-2 text-status-error"
                          onClick={() => {
                            setSessions(sessions.filter((_, j) => j !== i));
                            /*
                              Ticket rows point at sessions by position, so removing one shifts
                              every later session down by one. Rows of the removed session move
                              to the first session, where they stay visible.
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
                          <Trash2 aria-hidden="true" className="h-4 w-4" />
                          Remove {nouns.session.toLowerCase()} {i + 1}
                        </Button>
                      )}
                    </fieldset>
                  ))}
                  <Button
                    variant="outline"
                    onClick={() => {
                      const last = sessions[sessions.length - 1];
                      setSessions([
                        ...sessions,
                        {
                          ...EMPTY_SESSION,
                          /*
                            The next day at the same times: a run of nights is the common case,
                            and the date is one click to change. Shown, never hidden.
                          */
                          startsAt: last ? dayLater(last.startsAt) : '',
                          endsAt: last ? dayLater(last.endsAt) : '',
                          // A new night of a seated run is seated where the last one was.
                          ...(admission === 'seated'
                            ? { screenId: last?.screenId ?? '', seatMapId: last?.seatMapId ?? '' }
                            : {}),
                        },
                      ]);
                    }}
                  >
                    <Plus aria-hidden="true" className="h-4 w-4" />
                    Add another {nouns.session.toLowerCase()}
                  </Button>
                </section>
              </div>
            )}

            {current.id === 'tickets' && (
              <div className="space-y-5">
                {/*
                  ── HOW PEOPLE GET IN, ASKED FIRST ──────────────────────────────────────
                  Each answer changes what the rest of the step asks: free needs no prices,
                  paid needs ticket types with prices, and reserved seating needs a seat map per
                  session and no ticket types at all. Radios underneath: one tab stop.
                */}
                <fieldset>
                  <legend className="mb-2 text-[0.9375rem] font-medium text-text-primary">
                    How do people get in?
                  </legend>
                  <div className="grid gap-2 sm:grid-cols-3">
                    {ADMISSION_CHOICES.map((choice, i) => {
                      const checked = admission === choice.value;
                      const unavailable = choice.value === 'seated' && !seatingAvailable;
                      const Icon =
                        choice.value === 'free'
                          ? Gift
                          : choice.value === 'paid'
                            ? Ticket
                            : Armchair;
                      const description =
                        choice.value === 'free'
                          ? 'Nobody pays. No checkout and no fees.'
                          : choice.value === 'paid'
                            ? nouns.ticket === 'Pass'
                              ? 'Paid passes, any number of kinds.'
                              : 'Buyers choose how many tickets they want.'
                            : unavailable
                              ? roomsQ.isLoading
                                ? 'Checking this venue for a seat map...'
                                : 'Needs a seat map at this venue.'
                              : 'Buyers pick a named seat from the seat map.';
                      return (
                        <label
                          key={choice.value}
                          className={`relative flex min-h-11 gap-2.5 rounded-md border px-3 py-2.5 text-sm transition-colors focus-within:ring-2 focus-within:ring-action-primary focus-within:ring-offset-1 ${
                            unavailable
                              ? 'cursor-not-allowed border-border bg-background-subtle text-text-muted'
                              : checked
                                ? 'cursor-pointer border-action-primary bg-tint-primary text-text-primary'
                                : 'cursor-pointer border-border-input bg-background-surface text-text-secondary hover:bg-background-subtle'
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
                          <Icon
                            aria-hidden="true"
                            className={`mt-0.5 h-4 w-4 shrink-0 ${checked ? 'text-action-primary' : ''}`}
                          />
                          <span className="flex flex-col">
                            <span id={`admission-${choice.value}`} className="font-medium">
                              {choice.label}
                            </span>
                            <span
                              id={`admission-${choice.value}-hint`}
                              className={`mt-0.5 text-caption ${checked ? 'text-text-secondary' : 'text-text-muted'}`}
                            >
                              {description}
                            </span>
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
                    Why reserved seating is sometimes not on offer, and the way to get it. Opened
                    in a NEW TAB: drawing a seat map lives on another screen, and the half-filled
                    form stays behind them (it is saved either way).
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
                      seat category, priced from the category. A second set typed here would
                      conflict, and the room's would win at the point of sale, silently.
                    */}
                    <div className="rounded-md border border-border bg-background-subtle p-3 text-sm">
                      <p className="font-medium">Ticket types come from the seat map</p>
                      <p className="mt-1 text-caption text-text-muted">
                        A ticket type is created for each seat category and priced from it. You can
                        change prices per {nouns.session.toLowerCase()} afterwards from the
                        event&apos;s pricing page.
                      </p>
                    </div>
                    {sessions.map((s, i) => (
                      <Select
                        key={i}
                        id={`sr${i}`}
                        label={
                          sessions.length === 1
                            ? 'Seat map'
                            : `Seat map for ${nouns.session.toLowerCase()} ${i + 1} (${sessionWhen(s, i, nouns.session)})`
                        }
                        required
                        value={s.seatMapId}
                        error={fieldErrors[`s${i}Seat`]}
                        onBlur={() => reveal(`s${i}Seat`)}
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
                  <div className="space-y-3">
                    {isFree ? (
                      <p className="rounded-md border border-border bg-background-subtle p-3 text-caption text-text-secondary">
                        Nobody is charged, so there is no checkout, no booking fee and no platform
                        share. Attendees still book, get tickets and QR codes, and can cancel.
                      </p>
                    ) : (
                      <p className="text-caption text-text-muted">
                        Prices are in {eventCurrency}, the currency of the venue&apos;s country.
                      </p>
                    )}
                    {/*
                      More tickets than the room holds: a warning, not a block. Counted per
                      SESSION, because that is what fills the room.
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
                            {nouns.session} {i + 1} has {forSession.toLocaleString()} on sale but
                            the venue holds {venueCapacity.toLocaleString()}. Change one of them if
                            that is not deliberate.
                          </p>
                        );
                      })}
                    {tickets.map((t, i) => (
                      /*
                        One group per ticket type, named "Ticket type 2" (or "Pass 2"). Every
                        row has a "Name" and a "Price", and the group tells them apart.
                      */
                      <fieldset key={i} className="rounded-md border border-border p-3 sm:p-4">
                        <legend className="px-1 text-caption font-semibold text-text-secondary">
                          {nouns.ticket} {i + 1}
                        </legend>
                        <div
                          className={`grid grid-cols-2 gap-3 ${isFree ? 'md:grid-cols-[minmax(0,2fr)_minmax(0,1fr)_minmax(0,1fr)]' : 'md:grid-cols-[minmax(0,2fr)_minmax(0,1fr)_minmax(0,1fr)_minmax(0,1fr)]'}`}
                        >
                          {/* Full width on a phone; the three numbers share the row below. */}
                          <div className="col-span-2 md:col-span-1">
                            <Input
                              id={`tn${i}`}
                              label="Name"
                              required
                              placeholder={
                                exp.ticketSuggestions[0]
                                  ? `e.g. ${exp.ticketSuggestions[0]}`
                                  : undefined
                              }
                              value={t.name}
                              onChange={(e) =>
                                setTickets(
                                  tickets.map((x, j) =>
                                    j === i ? { ...x, name: e.target.value } : x,
                                  ),
                                )
                              }
                              onBlur={() => reveal(`t${i}Name`)}
                              error={fieldErrors[`t${i}Name`]}
                            />
                          </div>
                          {/* No price on a free event: a question that does not apply. */}
                          {!isFree && (
                            <Input
                              id={`tp${i}`}
                              label={`Price (${currencySymbol})`}
                              type="number"
                              inputMode="decimal"
                              min={0}
                              required
                              placeholder="0.00"
                              className="tabular-nums"
                              value={t.priceMajor}
                              error={fieldErrors[`t${i}Price`]}
                              onBlur={() => reveal(`t${i}Price`)}
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
                            className="tabular-nums"
                            value={t.quantityTotal}
                            onBlur={() => reveal(`t${i}Qty`)}
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
                            className="tabular-nums"
                            value={t.maxPerOrder}
                            error={fieldErrors[`t${i}Max`]}
                            onBlur={() => reveal(`t${i}Max`)}
                            onChange={(e) =>
                              setTickets(
                                tickets.map((x, j) =>
                                  j === i ? { ...x, maxPerOrder: e.target.value } : x,
                                ),
                              )
                            }
                          />
                        </div>
                        {(sessions.length > 1 || tickets.length > 1) && (
                          <div className="mt-3 flex flex-wrap items-end justify-between gap-3">
                            {sessions.length > 1 ? (
                              <div className="min-w-[12rem] flex-1">
                                <Select
                                  id={`tsi${i}`}
                                  label={`On sale for`}
                                  value={t.sessionIndex}
                                  onChange={(e) =>
                                    setTickets(
                                      tickets.map((x, j) =>
                                        j === i
                                          ? { ...x, sessionIndex: Number(e.target.value) }
                                          : x,
                                      ),
                                    )
                                  }
                                >
                                  {/* Named by when it starts: the date is what they chose. */}
                                  {sessions.map((sess, si) => (
                                    <option key={si} value={si}>
                                      {sessionWhen(sess, si, nouns.session)}
                                    </option>
                                  ))}
                                </Select>
                              </div>
                            ) : (
                              <span />
                            )}
                            {tickets.length > 1 && (
                              <Button
                                variant="ghost"
                                size="sm"
                                className="text-status-error"
                                onClick={() => setTickets(tickets.filter((_, j) => j !== i))}
                              >
                                <Trash2 aria-hidden="true" className="h-4 w-4" />
                                Remove {nouns.ticket.toLowerCase()} {i + 1}
                              </Button>
                            )}
                          </div>
                        )}
                      </fieldset>
                    ))}
                    <p className="text-caption text-text-muted">
                      Quantity is how many you sell, not the venue&apos;s capacity. Max per order is
                      the most one buyer can take at once.
                    </p>
                    {/*
                      The running total, per session: several ticket types make "how many am I
                      letting in" a sum the organizer would otherwise do in their head.
                    */}
                    <p role="status" className="text-sm font-medium tabular-nums text-text-primary">
                      {sessions.length === 1
                        ? `Total on sale: ${totals[0].toLocaleString()} ${totals[0] === 1 ? 'place' : 'places'}`
                        : `Total on sale: ${totals
                            .map(
                              (n, i) =>
                                `${nouns.session.toLowerCase()} ${i + 1}, ${n.toLocaleString()}`,
                            )
                            .join('; ')}`}
                      {venueCapacity !== null
                        ? ` (the venue holds ${venueCapacity.toLocaleString()})`
                        : ''}
                    </p>
                    {/*
                      The second row is usually one of a few names. Offered as one click each,
                      named and priced by the organizer: nothing is priced for them.
                    */}
                    <div className="flex flex-wrap items-center gap-2">
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => setTickets([...tickets, newTicketRow(tickets)])}
                      >
                        <Plus aria-hidden="true" className="h-4 w-4" />
                        Add {nouns.ticket.toLowerCase()}
                      </Button>
                      {exp.ticketSuggestions
                        .filter(
                          (name) =>
                            !tickets.some(
                              (t) => t.name.trim().toLowerCase() === name.toLowerCase(),
                            ),
                        )
                        .slice(0, 3)
                        .map((name) => (
                          <Button
                            key={name}
                            variant="ghost"
                            size="sm"
                            onClick={() =>
                              setTickets([...tickets, { ...newTicketRow(tickets), name }])
                            }
                          >
                            <Plus aria-hidden="true" className="h-4 w-4" />
                            {name}
                          </Button>
                        ))}
                    </div>
                  </div>
                )}
              </div>
            )}

            {current.id === 'details' && (
              <div className="space-y-5">
                <EventGalleryEditor
                  tiles={images.map((image) => ({ key: image.key, url: image.url }))}
                  busy={preparingImages}
                  error={imageError}
                  note={
                    restoredAt !== null && images.length === 0
                      ? 'Images are not kept in a saved draft. Add them again if you had some.'
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
                        .filter((image): image is WizardImage => Boolean(image)),
                    )
                  }
                />
                {cover && cover.width > 0 ? (
                  <CoverFocus
                    url={cover.url}
                    width={cover.width}
                    height={cover.height}
                    value={focal[cover.key] ?? CENTRE_FOCAL_POINT}
                    onChange={(point) => setFocal((f) => ({ ...f, [cover.key]: point }))}
                  />
                ) : null}
                <EventDetailsFields value={details} onChange={setDetails} />
                {/*
                  ── THE REFUND RULE, THEN THE PROSE ─────────────────────────────────────
                  The two controls that DECIDE come first (`refundsEnabled`, enforced by the
                  refund path), and the box that describes comes after, labelled as words.
                */}
                <fieldset className="space-y-3 rounded-md border border-border p-4">
                  <legend className="px-1 text-sm font-semibold">Refunds</legend>
                  <label className="flex items-start gap-3">
                    <input
                      id="refunds-enabled"
                      type="checkbox"
                      className="mt-1 h-4 w-4 accent-action-primary"
                      checked={basics.refundsEnabled}
                      onChange={(e) => setBasics({ ...basics, refundsEnabled: e.target.checked })}
                    />
                    <span className="text-sm">
                      <span className="font-medium">Attendees can request a refund</span>
                      <span className="mt-1 block text-caption text-text-muted">
                        Turn this off and the refund button never appears. Your team can still
                        refund someone by hand.
                      </span>
                    </span>
                  </label>
                  {basics.refundsEnabled && (
                    <Select
                      id="refund-cutoff"
                      label="Refunds close"
                      value={basics.refundCutoffHours}
                      hint="Measured back from the start. After this point the button is gone."
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
                    placeholder="e.g. Rain does not cancel the event."
                    hint="Shown to buyers next to the rule above. Words only: the settings above are what the platform enforces."
                    value={basics.refundPolicy}
                    onChange={(e) => setBasics({ ...basics, refundPolicy: e.target.value })}
                  />
                </fieldset>
              </div>
            )}

            {current.id === 'review' && (
              <div className="space-y-5 text-sm">
                {/*
                  ── READY OR NOT, IN ONE LINE ───────────────────────────────────────────
                  "Setup complete" or "<n> things to set up" - the console's words for this
                  everywhere - with each missing thing and a way straight to it. The create
                  buttons stay off until it is complete.
                */}
                {outstanding.length > 0 ? (
                  <section
                    aria-labelledby="review-missing"
                    className="rounded-md border border-status-error/40 bg-tint-error p-4"
                  >
                    <h3
                      id="review-missing"
                      className="flex items-center gap-2 font-semibold text-status-error"
                    >
                      <CircleAlert aria-hidden="true" className="h-4 w-4" />
                      {thingsToSetUp === 1
                        ? '1 thing to set up'
                        : `${thingsToSetUp} things to set up`}
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
                ) : (
                  <p className="flex items-center gap-2 rounded-md border border-status-success/40 bg-tint-success px-4 py-3 font-semibold text-status-success">
                    <CircleCheck aria-hidden="true" className="h-4 w-4" />
                    Setup complete
                  </p>
                )}

                {/*
                  What the SERVER says the organization still needs before anything sells -
                  the same list the dashboard reads. Only what blocks; links open in a new tab
                  so this page and its answers stay put.
                */}
                {(orgReadinessQ.data?.items ?? []).filter((i) => i.severity === 'BLOCKING').length >
                0 ? (
                  <section
                    aria-labelledby="review-org"
                    className="rounded-md border border-status-warning/40 bg-tint-warning p-4"
                  >
                    <h3 id="review-org" className="font-semibold text-status-warning">
                      Before tickets can sell, your organization needs
                    </h3>
                    <ul className="mt-2 space-y-2">
                      {orgReadinessQ
                        .data!.items.filter((i) => i.severity === 'BLOCKING')
                        .map((item) => (
                          <li key={item.key} className="text-text-primary">
                            <span className="font-medium">{item.title}.</span>{' '}
                            <span className="text-text-secondary">{item.consequence}</span>{' '}
                            <a
                              href={item.fixPath}
                              target="_blank"
                              rel="noopener noreferrer"
                              // Ink, not the accent: teal on the warning tint fails contrast in dark mode.
                              className="font-medium text-text-primary underline underline-offset-2"
                            >
                              Fix this (opens in a new tab)
                            </a>
                          </li>
                        ))}
                    </ul>
                    <p className="mt-2 text-caption text-text-secondary">
                      You can still create the event now.
                    </p>
                  </section>
                ) : null}

                {/* On a wide screen the preview is already beside the form. */}
                <section aria-labelledby="review-preview" className="space-y-3 xl:hidden">
                  <h3 id="review-preview" className="font-semibold text-text-primary">
                    What buyers will see
                  </h3>
                  <div className="mx-auto max-w-sm">{preview}</div>
                </section>

                <dl className="divide-y divide-border rounded-md border border-border">
                  <ReviewRow label="Event" onEdit={() => goTo(0)} editLabel="Edit basics">
                    {basics.title || '-'}{' '}
                    <span className="text-text-muted">({basics.category})</span>
                  </ReviewRow>
                  <ReviewRow label="Venue" onEdit={() => goTo(1)} editLabel="Edit where and when">
                    {venueMode === 'existing'
                      ? chosenVenue
                        ? `${chosenVenue.name}, ${chosenVenue.city}`
                        : '-'
                      : `${newVenue.name}, ${newVenue.city} (new)`}
                  </ReviewRow>
                  <ReviewRow
                    label={sessions.length === 1 ? 'When' : `When (${sessions.length})`}
                    onEdit={() => goTo(1)}
                    editLabel="Edit dates and times"
                  >
                    {sessions.map((s, i) => sessionWhen(s, i, nouns.session)).join(', ')}
                    {eventTimezone ? (
                      <span className="block text-caption text-text-muted">
                        {zoneLabel(eventTimezone)}
                      </span>
                    ) : null}
                  </ReviewRow>
                  <ReviewRow label="Admission" onEdit={() => goTo(2)} editLabel="Edit tickets">
                    {admission === 'free'
                      ? 'Free - no payment taken'
                      : admission === 'paid'
                        ? 'Paid - general admission'
                        : admission === 'seated'
                          ? 'Reserved seating'
                          : 'Not chosen yet'}
                  </ReviewRow>
                  {/*
                    Seating is named, not counted: booking a run into the wrong auditorium is
                    the mistake this page exists to catch.
                  */}
                  {admission === 'seated' ? (
                    <ReviewRow label="Seating">
                      {sessions.length === 1
                        ? `Assigned seats: ${roomByLayout(sessions[0].seatMapId)?.name ?? 'no seat map chosen'}`
                        : sessions
                            .map((x, i) => {
                              const room = roomByLayout(x.seatMapId);
                              return `${i + 1}: ${room ? room.name : 'no seat map chosen'}`;
                            })
                            .join(', ')}
                    </ReviewRow>
                  ) : (
                    <ReviewRow label={nouns.ticket === 'Pass' ? 'Passes' : 'Tickets'}>
                      <span className="tabular-nums">
                        {sentTickets
                          .map(
                            (t) =>
                              `${t.name} (${isFree ? 'Free' : money(Math.round(Number(t.priceMajor) * 100), eventCurrency)} x ${t.quantityTotal})`,
                          )
                          .join(', ')}
                      </span>
                    </ReviewRow>
                  )}
                  <ReviewRow label="Details" onEdit={() => goTo(3)} editLabel="Edit details">
                    {[
                      images.length === 0
                        ? 'No images'
                        : `${images.length} image${images.length === 1 ? '' : 's'}`,
                      details.ageLimit ? `${details.ageLimit}+` : 'No age limit',
                      (() => {
                        const n = eventDetailsBody(details).artists.length;
                        return n ? `${n} artist${n === 1 ? '' : 's'}` : null;
                      })(),
                      (() => {
                        const n = termsList(details.termsAndConditions).length;
                        return n ? `${n} term${n === 1 ? '' : 's'}` : null;
                      })(),
                      basics.refundsEnabled
                        ? `Refunds until ${(
                            REFUND_CUTOFFS.find((c) => c.value === basics.refundCutoffHours)
                              ?.label ?? `${basics.refundCutoffHours} hours before`
                          ).toLowerCase()}`
                        : 'No refunds for attendees',
                    ]
                      .filter(Boolean)
                      .join(' · ')}
                  </ReviewRow>
                </dl>

                {!isFree && admission !== '' && (
                  /*
                    Answered, and changeable: a default an organizer can see and override
                    without having been stopped by it. Phrased as what the buyer pays.
                  */
                  <div className="grid gap-2 rounded-md border border-border p-4 sm:grid-cols-[minmax(0,1fr)_minmax(0,1fr)] sm:items-end">
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
                    <p className="text-caption text-text-muted">
                      {buyerFeeNote(admission, feeMode)} Most organizers leave this as it is.
                    </p>
                  </div>
                )}
                {isFree ? (
                  <p className="text-caption text-text-muted">{buyerFeeNote(admission, feeMode)}</p>
                ) : null}

                {/*
                  ── WHAT THE TWO BUTTONS DO ─────────────────────────────────────────────
                  Said before they are pressed, from what the API does with each - including
                  the status the event will have afterwards.
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
          </section>

          {/* Below the wide layout the preview is one tap away rather than gone. */}
          {current.id !== 'review' ? (
            <details className="group rounded-lg border border-border bg-background-surface xl:hidden">
              <summary className="cursor-pointer list-none rounded-lg px-4 py-3 text-sm font-medium text-text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-action-primary">
                Preview what buyers will see
                <span className="ml-2 text-caption font-normal text-text-muted group-open:hidden">
                  Show
                </span>
              </summary>
              <div className="mx-auto max-w-sm px-4 pb-4">{preview}</div>
            </details>
          ) : null}

          <ActionBar>
            <Button
              variant="outline"
              size="sm"
              onClick={() => (step === 0 ? setExperienceId('') : goTo(step - 1))}
              disabled={busy}
            >
              <ArrowLeft aria-hidden="true" className="hidden h-4 w-4 min-[360px]:inline" />
              Back
            </Button>
            {step < REVIEW_STEP ? (
              <>
                <Button variant="ghost" size="sm" onClick={saveDraftNow} className="ml-auto">
                  <Save aria-hidden="true" className="hidden h-4 w-4 min-[360px]:inline" />
                  Save draft
                </Button>
                <Button size="sm" onClick={() => goTo(step + 1)}>
                  Continue{' '}
                  <ArrowRight aria-hidden="true" className="hidden h-4 w-4 min-[360px]:inline" />
                </Button>
              </>
            ) : (
              <>
                {/* Siblings, not a group, so on a phone the primary wraps to its own full row. */}
                <Button
                  variant="outline"
                  size="sm"
                  className="ml-auto"
                  loading={busy}
                  disabled={outstanding.length > 0}
                  onClick={() => commit(false)}
                >
                  Create draft event
                </Button>
                <Button
                  size="sm"
                  className="max-[480px]:w-full"
                  loading={busy}
                  disabled={outstanding.length > 0}
                  onClick={() => commit(true)}
                >
                  {submitLabel}
                </Button>
              </>
            )}
            {savedNotice ? (
              <p role="status" className="w-full text-caption text-text-secondary">
                {savedNotice}
              </p>
            ) : null}
          </ActionBar>
        </div>

        {/*
          ── THE CONTEXT PANEL ──────────────────────────────────────────────────────────
          On a wide screen the space beside the form shows the event as buyers will see it,
          updating as it is typed, and what is still to set up - instead of empty canvas.
        */}
        <aside
          aria-label="Live preview"
          className="hidden xl:sticky xl:top-20 xl:block xl:space-y-4"
        >
          <div>
            <h2 className="mb-2 text-caption font-semibold uppercase tracking-wide text-text-muted">
              What buyers will see
            </h2>
            {preview}
          </div>
          <div className="rounded-lg border border-border bg-background-surface p-4">
            <p
              className={`flex items-center gap-2 text-sm font-semibold ${
                thingsToSetUp === 0 ? 'text-status-success' : 'text-text-primary'
              }`}
            >
              {thingsToSetUp === 0 ? (
                <CircleCheck aria-hidden="true" className="h-4 w-4" />
              ) : (
                <CircleAlert aria-hidden="true" className="h-4 w-4 text-text-muted" />
              )}
              {thingsToSetUp === 0
                ? 'Setup complete'
                : `${thingsToSetUp} ${thingsToSetUp === 1 ? 'thing' : 'things'} to set up`}
            </p>
            <ul className="mt-2 space-y-1 text-caption">
              {stepTitles.slice(0, REVIEW_STEP).map((s, i) => {
                const n = Object.keys(errorsByStep[s.id]).length;
                return (
                  <li key={s.id} className="flex justify-between gap-2">
                    <span className="text-text-secondary">{s.title}</span>
                    <span
                      className={
                        n === 0 && i <= furthest ? 'text-status-success' : 'text-text-muted'
                      }
                    >
                      {n > 0
                        ? i <= furthest
                          ? `${n} to do`
                          : 'Not started'
                        : i <= furthest
                          ? 'Done'
                          : s.id === 'details'
                            ? 'Optional'
                            : 'Not started'}
                    </span>
                  </li>
                );
              })}
            </ul>
          </div>
        </aside>
      </div>
    </div>
  );
}

/*
  The step's actions, held at the bottom of the screen while the form scrolls, so Continue is
  never a scroll away. One primary action; Back and Save draft are quieter.
*/
function ActionBar({ children }: { children: ReactNode }) {
  return (
    <div className="sticky bottom-0 z-20 -mx-4 border-t border-border bg-background-surface/95 px-4 py-3 backdrop-blur supports-[backdrop-filter]:bg-background-surface/85 sm:mx-0 sm:rounded-lg sm:border sm:shadow-md">
      <div className="flex flex-wrap items-center gap-2">{children}</div>
    </div>
  );
}

/** One line of Review, with the way back to change it. */
function ReviewRow({
  label,
  children,
  onEdit,
  editLabel,
}: {
  label: string;
  children: ReactNode;
  onEdit?: () => void;
  editLabel?: string;
}) {
  // Only <dt> and <dd> in the group: the Edit button sits inside the answer it changes.
  return (
    <div className="grid grid-cols-[6.5rem_minmax(0,1fr)] items-start gap-3 px-3 py-2.5 sm:grid-cols-[8rem_minmax(0,1fr)]">
      <dt className="pt-1.5 text-text-muted">{label}</dt>
      <dd className="flex min-w-0 items-start justify-between gap-2">
        <span className="min-w-0 break-words pt-1.5 font-medium text-text-primary">{children}</span>
        {onEdit ? (
          <Button variant="ghost" size="sm" onClick={onEdit} aria-label={editLabel}>
            Edit
          </Button>
        ) : null}
      </dd>
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
