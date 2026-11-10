'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import {
  Armchair,
  ArrowRight,
  CalendarClock,
  CircleCheck,
  ImagePlus,
  Info,
  MapPin,
  ScrollText,
  Ticket,
  Undo2,
  type LucideIcon,
} from 'lucide-react';
import {
  api,
  apiAssetUrl,
  Button,
  CENTRE_FOCAL_POINT,
  FOCUS_RING,
  IconTile,
  Input,
  Select,
  Textarea,
  Skeleton,
  ErrorState,
  useToast,
  errorMessage,
  currencyForCountry,
  dateTime,
  eventImageSource,
  money,
  zoneAbbrev,
  type OrgEventDetail,
  type TileTone,
  type AttendanceMode,
} from '@eticketsgo/web-kit';
import { useOrg } from '@/components/org-context';
import { EditStateNote } from '@/components/events/edit-state-note';
import {
  canEditEvents,
  datesSummary,
  editLabel,
  eventDetailsEditability,
  eventSalesFacts,
  freePaidEditability,
  imagesEditability,
  ROLE_LOCK_NOTE,
  type Editability,
  type EditKind,
} from '@/lib/event-editability';
import {
  categoryBody,
  categoryFieldFrom,
  EVENT_CATEGORIES,
  isListedCategory,
  TYPE_LABEL_MAX,
} from '@/lib/templates';
import {
  EVENT_IMAGE_MAX_COUNT,
  EventGalleryEditor,
  prepareEventImage,
  type GalleryTile,
} from '@/components/event-image-picker';
import { EventImageFocus } from '@/components/event-image-focus';
import { PendingImageUploads } from '@/components/image-upload-status';
import {
  EMPTY_EVENT_DETAILS,
  EventDetailsFields,
  eventDetailsBody,
  eventDetailsFrom,
  type EventDetailsValue,
} from '@/components/event-details-fields';
import { BuyerPreview } from '@/components/create-event/buyer-preview';
import { TaxClassificationField, taxCategoryBody } from '@/components/tax-classification-field';
import {
  FEE_MODE_CHOICES,
  REFUND_CUTOFF_CHOICES,
  validateBasics,
  type FieldErrors,
} from '@/lib/event-wizard';

/*
  The refund rule is on the event (the API returns and accepts it, and review covers it) but
  not on the console's event type yet. Read here with the type widened, rather than changing
  the shared type from this page.
*/
type WithRefundRule = OrgEventDetail & { refundsEnabled?: boolean; refundCutoffHours?: number };

interface EditForm {
  title: string;
  category: string;
  description: string;
  refundPolicy: string;
  refundsEnabled: boolean;
  refundCutoffHours: string;
  feeMode: string;
  isFree: boolean;
  /** '' is "not set". */
  taxCategory: string;
  attendanceMode: AttendanceMode;
}

function formFrom(event: WithRefundRule): EditForm {
  return {
    title: event.title,
    category: categoryFieldFrom(event).text,
    description: event.description ?? '',
    refundPolicy: event.refundPolicy ?? '',
    refundsEnabled: event.refundsEnabled ?? true,
    refundCutoffHours: String(event.refundCutoffHours ?? 0),
    feeMode: event.feeMode,
    isFree: event.isFree,
    taxCategory: event.taxCategory ?? '',
    attendanceMode:
      ((event as { attendanceMode?: AttendanceMode }).attendanceMode as AttendanceMode) ??
      'IN_PERSON',
  };
}

/*
  ── THE SAME SECTIONS AS CREATE ────────────────────────────────────────────────────
  Walking "edit it later" as a first-time organizer, this page was a different product from
  the wizard they had just used: one long card in another order, "Title" here and "Event
  title" there, the raw value "CUSTOMER PAYS" under "Fee handling", no way to change the
  refund rule they had set, a one-letter title it would save and the wizard would refuse, and
  no way from here to the ticket types - the thing most people come back to change.

  Now it is the wizard's sections, in the wizard's order and words, each a card led by the same
  coloured tile: Basics, Event images, Details (with the same refund controls), Tickets (free
  or paid, who pays the fee, and links to the pages that hold dates, ticket types and seating).
  Save sits in a bar that stays on screen and says whether anything is unsaved, and on a wide
  screen the buyer's card sits beside the form as it does while creating.

  ORDER AND LOCKS (2026-11): Details, Dates and sessions, Tickets and prices, Venue, Policies.
  Each section says whether it can change now, can change but may go back to review, or is
  locked and why - from lib/event-editability, which mirrors the server's rules. Controls used
  to go grey or vanish with no word, and the page never said that dates and ticket types stay
  changeable on their own pages while the details are locked.

  What is SENT is unchanged: the same update call with the same fields, plus the refund rule
  the API already accepts on update. The images still save on their own, through the same
  queue, as before. The refund fields are sent only when they changed, so a save that does not
  touch them sends exactly what it sent before.
*/
export default function EditEvent() {
  const { id } = useParams<{ id: string }>();
  const qc = useQueryClient();
  const toast = useToast();
  const { activeOrg } = useOrg();
  const {
    data: rawEvent,
    isLoading,
    isError,
    refetch,
  } = useQuery({
    queryKey: ['event', id],
    queryFn: () => api.events.get(id),
  });
  const event = rawEvent as WithRefundRule | undefined;

  const [form, setForm] = useState<EditForm>({
    title: '',
    category: '',
    description: '',
    refundPolicy: '',
    refundsEnabled: true,
    refundCutoffHours: '0',
    feeMode: 'CUSTOMER_PAYS',
    isFree: false,
    taxCategory: '',
    attendanceMode: 'IN_PERSON',
  });
  /* What the server holds, for "unsaved changes" and for sending the refund rule only if it moved. */
  const [loaded, setLoaded] = useState<{ form: EditForm; details: EventDetailsValue } | null>(null);
  /* Typed rather than picked, when the stored value is not one of the offered options. */
  const [categoryMode, setCategoryMode] = useState<'list' | 'other'>('list');
  const [details, setDetails] = useState<EventDetailsValue>(EMPTY_EVENT_DETAILS);
  /* Which problems have been pointed out: on leaving the field, or on a refused Save. */
  const [shown, setShown] = useState<Record<string, true>>({});

  /*
    The event is read again after every image change, and that used to refill the whole form -
    so "type a new title, then add a cover, then Save" saved the OLD title, silently: the
    walkthrough's edit script did exactly that. Answers are refilled only when the organizer has
    not changed them since the last read; typed changes survive an image upload.
  */
  const edits = useRef({ form, details, loaded });
  edits.current = { form, details, loaded };
  useEffect(() => {
    if (!event) return;
    const next = formFrom(event);
    const nextDetails = eventDetailsFrom(event);
    const { form: now, details: nowDetails, loaded: before } = edits.current;
    const untouched =
      before === null ||
      (JSON.stringify(now) === JSON.stringify(before.form) &&
        JSON.stringify(nowDetails) === JSON.stringify(before.details));
    if (untouched) {
      setForm(next);
      setCategoryMode(categoryFieldFrom(event).mode);
      setDetails(nextDetails);
    }
    setLoaded({ form: next, details: nextDetails });
  }, [event]);

  const problems: FieldErrors = validateBasics(form);
  const fieldError = (key: string) => (shown[key] ? problems[key] : undefined);
  const dirty =
    loaded !== null &&
    (JSON.stringify(form) !== JSON.stringify(loaded.form) ||
      JSON.stringify(eventDetailsBody(details)) !==
        JSON.stringify(eventDetailsBody(loaded.details)));

  const save = useMutation({
    mutationFn: () => {
      const refundChanged =
        loaded !== null &&
        (form.refundsEnabled !== loaded.form.refundsEnabled ||
          form.refundCutoffHours !== loaded.form.refundCutoffHours);
      return api.events.update(id, {
        title: form.title,
        /*
          An event saved before "Other event type" existed keeps its hand-typed category until
          the organizer changes that text: a save of some other field must not move it.
        */
        ...(categoryMode === 'other' &&
        !event?.typeLabel &&
        event &&
        !isListedCategory(event.category) &&
        event.category !== 'Other' &&
        form.category === event.category
          ? { category: form.category }
          : categoryBody(categoryMode, form.category)),
        description: form.description || undefined,
        refundPolicy: form.refundPolicy || undefined,
        feeMode: form.feeMode,
        isFree: form.isFree,
        attendanceMode: form.attendanceMode,
        taxCategory: taxCategoryBody(form.taxCategory),
        ...(refundChanged
          ? {
              refundsEnabled: form.refundsEnabled,
              refundCutoffHours: Number(form.refundCutoffHours),
            }
          : {}),
        ...eventDetailsBody(details),
      });
    },
    onSuccess: (updated) => {
      /*
        A paused event whose reviewed details changed is marked by the server for review on
        resume (unless the organization is trusted), so the toast says so rather than "done".
      */
      const marked = (updated as { needsReviewOnResume?: boolean } | undefined)
        ?.needsReviewOnResume;
      toast.push(
        marked
          ? 'Changes saved. When you resume sales, our team may review them before the event sells again.'
          : 'Changes saved.',
        'success',
      );
      setShown({});
      qc.invalidateQueries({ queryKey: ['event', id] });
    },
    // The server's own words, as a toast and beside Save until the next try.
    onError: (e) => toast.push(errorMessage(e), 'error'),
  });

  /* Cancel: put back what the server holds. Images are not included; they saved on their own. */
  const discard = () => {
    if (!loaded || !event) return;
    setForm(loaded.form);
    setDetails(loaded.details);
    setCategoryMode(categoryFieldFrom(event).mode);
    setShown({});
    save.reset();
  };

  /* The wizard's own title and category rule, checked before the call rather than after it. */
  const trySave = () => {
    if (Object.keys(problems).length > 0) {
      setShown({ title: true, category: true });
      const first = problems.title
        ? 'title'
        : categoryMode === 'other'
          ? 'category-other'
          : 'category';
      document.getElementById(first)?.focus();
      return;
    }
    save.mutate();
  };

  /*
    Images save on their own, the moment they change — they are not part of "Save changes".

    Each picked file shows as a tile at once, from the organizer's own copy, marked uploading.
    Uploads run one after another through a single queue — also across separate picks — so
    images land in the order they were chosen. A saved image replaces its tile only after the
    event has been read back, so the picture never blinks out between the two; a refused one
    keeps its tile with the reason until it is dismissed.
  */
  const [imageError, setImageError] = useState<string | null>(null);
  const [pending, setPending] = useState<GalleryTile[]>([]);
  const nextKey = useRef(0);
  const queue = useRef<Promise<void>>(Promise.resolve());
  const objectUrls = useRef(new Set<string>());
  const refreshEvent = () => qc.invalidateQueries({ queryKey: ['event', id] });

  // Release the local previews when the organizer leaves the page.
  useEffect(() => {
    const urls = objectUrls.current;
    return () => urls.forEach((url) => URL.revokeObjectURL(url));
  }, []);

  const preview = (file: File) => {
    const url = URL.createObjectURL(file);
    objectUrls.current.add(url);
    return url;
  };
  const release = (url: string) => {
    URL.revokeObjectURL(url);
    objectUrls.current.delete(url);
  };
  const markFailed = (key: string, error: string) =>
    setPending((tiles) =>
      tiles.map((tile) => (tile.key === key ? { ...tile, status: 'failed', error } : tile)),
    );

  const addImages = (files: File[]) => {
    setImageError(null);
    const room = Math.max(
      0,
      EVENT_IMAGE_MAX_COUNT -
        (event?.images?.length ?? 0) -
        pending.filter((tile) => tile.status === 'uploading').length,
    );
    const batch = files.map((file, i) => ({
      file,
      tile: {
        key: `pending-${++nextKey.current}`,
        url: preview(file),
        ...(i < room
          ? { status: 'uploading' as const }
          : {
              status: 'failed' as const,
              error: `An event can have up to ${EVENT_IMAGE_MAX_COUNT} images.`,
            }),
      },
    }));
    setPending((tiles) => [...tiles, ...batch.map((b) => b.tile)]);

    queue.current = queue.current.then(async () => {
      let saved = 0;
      for (const { file, tile } of batch) {
        if (tile.status !== 'uploading') continue;
        try {
          await api.events.addImage(id, await prepareEventImage(file));
          await refreshEvent();
          saved += 1;
          setPending((tiles) => tiles.filter((t) => t.key !== tile.key));
          release(tile.url);
        } catch (err) {
          markFailed(tile.key, errorMessage(err));
        }
      }
      if (saved > 0) {
        toast.push(saved === 1 ? 'Image added.' : `${saved} images added.`, 'success');
      }
    });
  };

  const uploadingCount = pending.filter((tile) => tile.status === 'uploading').length;
  const removeImage = useMutation({
    mutationFn: (imageId: string) => api.events.removeImage(id, imageId),
    onSuccess: () => {
      setImageError(null);
      toast.push('Image removed.', 'success');
    },
    onError: (e) => setImageError(errorMessage(e)),
    onSettled: refreshEvent,
  });
  const reorderImages = useMutation({
    mutationFn: (imageIds: string[]) => api.events.reorderImages(id, imageIds),
    onSuccess: () => setImageError(null),
    onError: (e) => setImageError(errorMessage(e)),
    onSettled: refreshEvent,
  });
  // Saved on its own like the images themselves; the copies are cut again on the server.
  const [focusError, setFocusError] = useState<string | null>(null);
  const setFocalPoint = useMutation({
    mutationFn: (input: { imageId: string; x: number; y: number }) =>
      api.events.setImageFocalPoint(id, input.imageId, { x: input.x, y: input.y }),
    onSuccess: () => setFocusError(null),
    onError: (e) => setFocusError(errorMessage(e)),
    onSettled: refreshEvent,
  });
  /*
    The lock note said "Pause it first" and offered no way to: the organizer had to go back to
    the overview and find Pause in a menu. The button is here, where the need is.
  */
  const pauseToEdit = useMutation({
    mutationFn: () => api.events.pause(id),
    onSuccess: () => {
      toast.push('Sales paused. You can edit the details now.', 'success');
      refreshEvent();
    },
    onError: (e) => toast.push(errorMessage(e), 'error'),
  });

  if (isError)
    return (
      <ErrorState message="We couldn't load this. Please try again." onRetry={() => refetch()} />
    );
  if (isLoading || !event) return <Skeleton className="h-64 w-full" />;
  /*
    What can change, from what the page already has. The server checks every request again;
    these only stop the page offering what it would refuse, and say why. See
    lib/event-editability for the rule behind each answer.
  */
  const canEdit = canEditEvents(activeOrg.myRole);
  const detailsState = eventDetailsEditability({
    status: event.status,
    canEdit,
    needsReviewOnResume: event.needsReviewOnResume,
    pausedByAdmin: event.pausedByAdmin,
  });
  const editable = detailsState.kind !== 'locked';
  const imagesState = imagesEditability({ status: event.status, canEdit });
  const imagesLocked = imagesState.kind === 'locked';
  const facts = eventSalesFacts(event.sessions);
  // Judged against the SAVED setting: the server compares the patch with what it holds.
  const freePaidState = freePaidEditability({
    details: detailsState,
    isFree: event.isFree,
    facts,
    bookingsOnFile: event._count?.bookings ?? 0,
  });
  const now = Date.now();
  const sessionFacts = event.sessions.map((sess) => ({
    status: sess.status,
    startsAt: sess.startsAt,
    endsAt: sess.endsAt,
    sold: (sess.ticketTypes ?? []).reduce((n, t) => n + (t.inventory?.quantitySold ?? 0), 0),
    held: (sess.ticketTypes ?? []).reduce((n, t) => n + (t.inventory?.quantityHeld ?? 0), 0),
  }));
  const datesState: Editability = canEdit
    ? datesSummary(sessionFacts, now, event.isFree)
    : { kind: 'locked', note: ROLE_LOCK_NOTE };
  const ticketsPagesState: Editability = canEdit
    ? {
        kind: 'editable',
        note: event.isFree
          ? 'Ticket types change on their own page, even while the event is on sale.'
          : 'Ticket types change on their own page, even while the event is on sale. A price can change only until the first ticket of that type sells. Buyers who already paid or are checking out keep the price they were shown.',
      }
    : { kind: 'locked', note: ROLE_LOCK_NOTE };
  const venueState: Editability = {
    kind: 'locked',
    note:
      facts.sold + facts.held > 0 || (event._count?.bookings ?? 0) > 0
        ? 'The venue is not changed from this page. This event has bookings, so it cannot move to another venue: add a new event there instead.'
        : 'The venue is not changed from this page. It sets the currency, the tax and the time zone of every date.',
  };
  const base = `/organizer/events/${id}`;

  /* The buyer's card, from what is saved plus what is being typed. */
  const currency = currencyForCountry(event.venue?.country) ?? 'INR';
  const zone = event.venue?.timezone || undefined;
  const firstStart = event.sessions
    .map((s) => s.startsAt)
    .filter(Boolean)
    .sort()[0];
  const prices = event.sessions.flatMap((s) => (s.ticketTypes ?? []).map((t) => t.priceMinor));
  const fromMinor = form.isFree ? 0 : prices.length ? Math.min(...prices) : null;
  const cover = eventImageSource(event.images?.[0], 'card');
  const ticketTypeCount = event.sessions.reduce((n, s) => n + (s.ticketTypes ?? []).length, 0);
  const seatedCount = event.sessions.filter((s) => s.seatMapId).length;
  const datesLinks: readonly [string, LucideIcon, string, string][] = [
    [
      'sessions',
      CalendarClock,
      'Dates and times',
      `${event.sessions.length} ${event.sessions.length === 1 ? 'date' : 'dates'}`,
    ],
    [
      'seating',
      Armchair,
      'Seating',
      seatedCount > 0
        ? `Reserved seating on ${seatedCount} of ${event.sessions.length}`
        : 'General admission',
    ],
  ];
  const ticketLinks: readonly [string, LucideIcon, string, string][] = [
    [
      'tickets',
      Ticket,
      'Ticket types and prices',
      `${ticketTypeCount} ${ticketTypeCount === 1 ? 'ticket type' : 'ticket types'}`,
    ],
  ];
  const sections: readonly [string, string][] = [
    ['edit-details', 'Details'],
    ['edit-dates', 'Dates and sessions'],
    ['edit-tickets', 'Tickets and prices'],
    ['edit-venue', 'Venue'],
    ['edit-policies', 'Policies'],
  ];

  return (
    <div className="mx-auto max-w-[76rem] pb-6">
      <div className="xl:grid xl:grid-cols-[minmax(0,45rem)_minmax(18rem,21rem)] xl:items-start xl:justify-between xl:gap-8">
        <div className="min-w-0 space-y-5">
          {/*
            The answer for the event's own details, first and in words. The pause button sits
            with it: the lock note used to say "pause it first" and offer no way to.
          */}
          <EditStateNote state={detailsState} id="edit-state">
            {event.status === 'PUBLISHED' && canEdit ? (
              <Button
                size="sm"
                variant="outline"
                loading={pauseToEdit.isPending}
                onClick={() => pauseToEdit.mutate()}
              >
                Pause sales and edit
              </Button>
            ) : null}
          </EditStateNote>

          <nav aria-label="Sections of this page">
            <ul className="flex flex-wrap gap-x-4 gap-y-1 text-caption">
              {sections.map(([anchor, label]) => (
                <li key={anchor}>
                  <a
                    href={`#${anchor}`}
                    className={`rounded text-action-primary underline ${FOCUS_RING}`}
                  >
                    {label}
                  </a>
                </li>
              ))}
            </ul>
          </nav>

          <Section
            id="edit-details"
            icon={Info}
            tone="teal"
            title="Details"
            intro="What the event is and what buyers should know."
            kind={detailsState.kind}
          >
            <Input
              id="title"
              label="Event title"
              required
              value={form.title}
              onChange={(e) => setForm({ ...form, title: e.target.value })}
              onBlur={() => setShown((s) => ({ ...s, title: true }))}
              error={fieldError('title')}
              disabled={!editable}
            />
            <Select
              id="category"
              label="Category"
              value={categoryMode === 'other' ? '__other' : form.category}
              disabled={!editable}
              hint="Where buyers find it when they browse."
              error={categoryMode === 'list' ? fieldError('category') : undefined}
              onBlur={() => setShown((s) => ({ ...s, category: true }))}
              onChange={(e) => {
                if (e.target.value === '__other') {
                  setCategoryMode('other');
                  setForm((f) => ({ ...f, category: '' }));
                } else {
                  setCategoryMode('list');
                  setForm((f) => ({ ...f, category: e.target.value }));
                }
              }}
            >
              <option value="">Select a category...</option>
              {EVENT_CATEGORIES.map((c) => (
                <option key={c} value={c}>
                  {c}
                </option>
              ))}
              <option value="__other">Other event type...</option>
            </Select>
            {categoryMode === 'other' && (
              <Input
                id="category-other"
                label="Event type"
                required
                maxLength={TYPE_LABEL_MAX}
                hint="Buyers see this on the event. It is listed under Other when they browse."
                value={form.category}
                onChange={(e) => setForm({ ...form, category: e.target.value })}
                onBlur={() => setShown((s) => ({ ...s, category: true }))}
                error={fieldError('category')}
                disabled={!editable}
              />
            )}
            {/*
              How people attend, said once and kept apart from the time zone. An online event
              is listed in every city of its country; its venue gives the country and the time
              zone and is never printed as an address.
            */}
            <Select
              id="attendance-mode"
              label="How people attend"
              hint="Online events are shown to buyers in every city of your country."
              value={form.attendanceMode}
              disabled={!editable}
              onChange={(e) =>
                setForm({ ...form, attendanceMode: e.target.value as AttendanceMode })
              }
            >
              <option value="IN_PERSON">In person, at the venue</option>
              <option value="ONLINE">Online only</option>
              <option value="HYBRID">In person and online</option>
            </Select>
            <Textarea
              id="desc"
              label="Description"
              rows={4}
              hint="Optional. What buyers read on the event page."
              value={form.description}
              onChange={(e) => setForm({ ...form, description: e.target.value })}
              disabled={!editable}
            />
            <EventDetailsFields value={details} onChange={setDetails} disabled={!editable} />

            {/*
              Images follow a looser rule than the fields above: they change while the event is
              live and skip review, because a picture is not part of what a buyer agreed to.
            */}
            <div className="space-y-3 border-t border-border pt-4">
              <h3 className="flex items-center gap-2 text-ui font-semibold text-text-primary">
                <ImagePlus aria-hidden="true" className="h-4 w-4 text-text-muted" />
                Images
              </h3>
              <EditStateNote state={imagesState} />
              <PendingImageUploads eventId={id} onUploaded={refreshEvent} />
              <EventGalleryEditor
                tiles={[
                  ...(event.images ?? []).map((image) => ({
                    key: image.id,
                    url: apiAssetUrl(image.path) ?? '',
                  })),
                  ...pending,
                ]}
                disabled={imagesLocked}
                // Order and removal wait for uploads, so a reorder never names a half-saved list.
                busy={uploadingCount > 0 || removeImage.isPending || reorderImages.isPending}
                error={imageError}
                note={null}
                onAdd={addImages}
                onRemove={(key) => {
                  const failed = pending.find((tile) => tile.key === key);
                  if (failed) {
                    setPending((tiles) => tiles.filter((tile) => tile.key !== key));
                    release(failed.url);
                  } else {
                    removeImage.mutate(key);
                  }
                }}
                onReorder={(imageIds) => reorderImages.mutate(imageIds)}
              />
              {(event.images?.length ?? 0) > 0 && (
                <EventImageFocus
                  images={event.images ?? []}
                  disabled={imagesLocked}
                  saving={setFocalPoint.isPending}
                  error={focusError}
                  onSave={(imageId, point) => setFocalPoint.mutate({ imageId, ...point })}
                />
              )}
            </div>
          </Section>

          <Section
            id="edit-dates"
            icon={CalendarClock}
            tone="blue"
            title="Dates and sessions"
            intro="When it happens and where people sit. Each has its own page."
            kind={datesState.kind}
          >
            <EditStateNote state={datesState} />
            <PageLinks label="Dates and seating" base={base} links={datesLinks} />
          </Section>

          <Section
            id="edit-tickets"
            icon={Ticket}
            tone="purple"
            title="Tickets and prices"
            intro="Free or paid, who pays the booking fee, and tax. Ticket types and their prices have their own page."
            kind={detailsState.kind}
          >
            {/*
              Switching between free and paid is refused by the API once anybody has booked, is
              checking out, or a payment, receipt or refund is on file; and turning free on is
              refused while a ticket type has a price. The control is disabled with the reason
              where the page can see the cause, rather than left to fail on save.
            */}
            <div className="space-y-2">
              <label className="flex items-start gap-3 rounded-md border border-border p-3">
                <input
                  id="is-free"
                  type="checkbox"
                  className="mt-1 h-4 w-4 accent-action-primary"
                  checked={form.isFree}
                  disabled={freePaidState.kind === 'locked'}
                  aria-describedby={
                    freePaidState.note !== detailsState.note ? 'is-free-state' : undefined
                  }
                  onChange={(e) => setForm({ ...form, isFree: e.target.checked })}
                />
                <span className="text-sm">
                  <span className="font-medium">Free event</span>
                  <span className="mt-1 block text-caption text-text-muted">
                    Nobody is charged, so there is no checkout, no booking fee and no platform
                    share. Attendees still book, get tickets and QR codes, and can cancel.
                  </span>
                </span>
              </label>
              {freePaidState.note !== detailsState.note && (
                <EditStateNote state={freePaidState} id="is-free-state" />
              )}
            </div>
            {!form.isFree && (
              <Select
                id="fee"
                label="Who pays the booking fee?"
                value={form.feeMode}
                onChange={(e) => setForm({ ...form, feeMode: e.target.value })}
                disabled={!editable}
              >
                {FEE_MODE_CHOICES.map((f) => (
                  <option key={f.value} value={f.value}>
                    {f.label}
                  </option>
                ))}
              </Select>
            )}
            {/* Shown only where tax depends on it - see TaxClassificationField. */}
            <TaxClassificationField
              venueId={event?.venue?.id}
              value={form.taxCategory}
              onChange={(taxCategory) => setForm({ ...form, taxCategory })}
              disabled={!editable}
            />
            <EditStateNote state={ticketsPagesState} />
            <PageLinks label="Ticket types" base={base} links={ticketLinks} />
          </Section>

          <Section
            id="edit-venue"
            icon={MapPin}
            tone="teal"
            title="Venue"
            intro="Where the event is held."
            kind={venueState.kind}
          >
            {event.venue ? (
              <dl className="grid gap-x-4 gap-y-1 text-sm sm:grid-cols-[8rem_minmax(0,1fr)]">
                <dt className="text-text-muted">Name</dt>
                <dd className="break-words text-text-primary">{event.venue.name}</dd>
                <dt className="text-text-muted">Address</dt>
                <dd className="break-words text-text-primary">
                  {[event.venue.address, event.venue.city, event.venue.region]
                    .filter(Boolean)
                    .join(', ')}
                </dd>
                <dt className="text-text-muted">Time zone</dt>
                <dd className="break-words text-text-primary">{event.venue.timezone}</dd>
              </dl>
            ) : (
              <p className="text-sm text-text-muted">No venue yet.</p>
            )}
            <EditStateNote state={venueState} />
            <p className="text-caption text-text-secondary">
              To correct the venue&apos;s own address or time zone, go to{' '}
              <Link
                href="/organizer/venues"
                className={`rounded text-action-primary underline ${FOCUS_RING}`}
              >
                Venues
              </Link>
              .
            </p>
          </Section>

          <Section
            id="edit-policies"
            icon={ScrollText}
            tone="amber"
            title="Policies"
            intro="Your refund rule. Terms and conditions are under Details, with what buyers should know."
            kind={detailsState.kind}
          >
            {/*
              The same refund controls as the wizard: the two that DECIDE first (enforced by the
              refund path), then the words shown beside them. The edit page used to offer only
              the words, so a rule chosen while creating could never be changed afterwards.
            */}
            <fieldset className="space-y-3 rounded-lg border border-border p-4 sm:p-5">
              <legend className="flex items-center gap-2 px-1 text-ui font-semibold text-text-primary">
                <Undo2 aria-hidden="true" className="h-4 w-4 text-text-muted" />
                Refunds
              </legend>
              <label className="flex items-start gap-3">
                <input
                  id="refunds-enabled"
                  type="checkbox"
                  className="mt-1 h-4 w-4 accent-action-primary"
                  checked={form.refundsEnabled}
                  disabled={!editable}
                  onChange={(e) => setForm({ ...form, refundsEnabled: e.target.checked })}
                />
                <span className="text-sm">
                  <span className="font-medium">Attendees can request a refund</span>
                  <span className="mt-1 block text-caption text-text-muted">
                    Turn this off and the refund button never appears. Your team can still refund
                    someone by hand.
                  </span>
                </span>
              </label>
              {form.refundsEnabled && (
                <Select
                  id="refund-cutoff"
                  label="Refunds close"
                  value={form.refundCutoffHours}
                  disabled={!editable}
                  hint="Measured back from the start. After this point the button is gone."
                  onChange={(e) => setForm({ ...form, refundCutoffHours: e.target.value })}
                >
                  {/* A stored value that is not one of the choices stays shown as it is. */}
                  {REFUND_CUTOFF_CHOICES.some((c) => c.value === form.refundCutoffHours) ? null : (
                    <option value={form.refundCutoffHours}>
                      {form.refundCutoffHours} hours before
                    </option>
                  )}
                  {REFUND_CUTOFF_CHOICES.map((c) => (
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
                value={form.refundPolicy}
                onChange={(e) => setForm({ ...form, refundPolicy: e.target.value })}
                disabled={!editable}
              />
            </fieldset>
          </Section>

          {/* Save stays on screen, as Continue does while creating. One primary action. */}
          <div className="sticky bottom-0 z-20 -mx-4 border-t border-border bg-background-surface/95 px-4 py-3 backdrop-blur supports-[backdrop-filter]:bg-background-surface/85 sm:mx-0 sm:rounded-lg sm:border sm:shadow-md">
            {save.isError ? (
              // The server's refusal, word for word, until the next save or cancel.
              <p role="alert" className="mb-2 text-caption text-status-error">
                Not saved: {errorMessage(save.error)}
              </p>
            ) : null}
            <div className="flex flex-wrap items-center gap-2">
              <p role="status" className="min-w-0 flex-1 text-caption text-text-secondary">
                {!editable ? (
                  'Details are locked. See the note at the top of this page.'
                ) : dirty ? (
                  detailsState.kind === 'review' ? (
                    'You have unsaved changes. Saving them may send the event back for review when you resume.'
                  ) : (
                    'You have unsaved changes.'
                  )
                ) : (
                  <span className="inline-flex items-center gap-1.5">
                    <CircleCheck aria-hidden="true" className="h-3.5 w-3.5 text-status-success" />
                    All changes saved
                  </span>
                )}
              </p>
              <Button
                variant="outline"
                disabled={!editable || !dirty || save.isPending}
                onClick={discard}
              >
                Cancel
              </Button>
              <Button loading={save.isPending} disabled={!editable} onClick={trySave}>
                Save changes
              </Button>
            </div>
          </div>
        </div>

        <aside
          aria-label="Live preview"
          className="hidden xl:sticky xl:top-20 xl:block xl:space-y-4"
        >
          <div className="rounded-lg border border-border bg-background-surface p-4 shadow-xs">
            <h2 className="mb-1 text-ui font-semibold text-text-primary">What buyers will see</h2>
            <BuyerPreview
              id="edit-preview"
              title={form.title || 'Your event title'}
              category={form.category}
              image={
                cover
                  ? // The card copy is already cut to the card's shape around the saved point.
                    { url: cover.src, width: 4, height: 3, focal: CENTRE_FOCAL_POINT }
                  : null
              }
              when={
                firstStart
                  ? `${dateTime(firstStart, undefined, zone)}${zone ? ` (${zoneAbbrev(firstStart, zone)})` : ''}${
                      event.sessions.length > 1 ? ` +${event.sessions.length - 1} more` : ''
                    }`
                  : 'No date yet'
              }
              where={event.venue ? `${event.venue.name}, ${event.venue.city}` : 'No venue yet'}
              organizer={activeOrg.name}
              price={
                fromMinor === 0
                  ? 'Free'
                  : fromMinor !== null
                    ? money(fromMinor, currency)
                    : 'No price yet'
              }
              showFrom={fromMinor !== null && fromMinor > 0}
            />
          </div>
        </aside>
      </div>
    </div>
  );
}

/** One section of the form: a card led by the same coloured tile as the wizard's step. */
function Section({
  id,
  icon,
  tone,
  title,
  intro,
  kind,
  children,
}: {
  id: string;
  icon: LucideIcon;
  tone: TileTone;
  title: string;
  intro?: string;
  /** Whether this group can change now; said as words beside the heading. */
  kind: EditKind;
  children: ReactNode;
}) {
  const badge =
    kind === 'editable'
      ? 'border-status-success/40 bg-tint-success text-text-primary'
      : kind === 'review'
        ? 'border-status-warning/40 bg-tint-warning text-text-primary'
        : 'border-border bg-background-subtle text-text-secondary';
  return (
    <section
      id={id}
      aria-labelledby={`${id}-title`}
      className="scroll-mt-20 rounded-lg border border-border bg-background-surface p-4 shadow-xs sm:p-6"
    >
      <div className="mb-5 flex items-start gap-3">
        <IconTile icon={icon} tone={tone} />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
            <h2
              id={`${id}-title`}
              className="font-display text-title font-bold tracking-tight text-text-primary"
            >
              {title}
            </h2>
            <span
              className={`rounded-full border px-2 py-0.5 text-micro font-semibold ${badge}`}
              data-testid={`${id}-state`}
            >
              {editLabel(kind)}
            </span>
          </div>
          {intro ? <p className="mt-0.5 text-caption text-text-secondary">{intro}</p> : null}
        </div>
      </div>
      <div className="space-y-4">{children}</div>
    </section>
  );
}

/** The pages that hold what this form does not: listed with what each holds now. */
function PageLinks({
  label,
  base,
  links,
}: {
  label: string;
  base: string;
  links: readonly (readonly [string, LucideIcon, string, string])[];
}) {
  return (
    <nav aria-label={label}>
      <ul className="divide-y divide-border overflow-hidden rounded-lg border border-border">
        {links.map(([seg, Icon, text, fact]) => (
          <li key={seg}>
            <Link
              href={`${base}/${seg}`}
              className={`flex min-h-12 items-center gap-3 px-3 py-2.5 text-sm transition-colors hover:bg-background-subtle ${FOCUS_RING}`}
            >
              <Icon aria-hidden="true" className="h-4 w-4 shrink-0 text-text-muted" />
              <span className="min-w-0 flex-1 font-medium text-text-primary">{text}</span>
              <span className="text-right text-caption tabular-nums text-text-muted">{fact}</span>
              <ArrowRight aria-hidden="true" className="h-4 w-4 shrink-0 text-text-muted" />
            </Link>
          </li>
        ))}
      </ul>
    </nav>
  );
}
