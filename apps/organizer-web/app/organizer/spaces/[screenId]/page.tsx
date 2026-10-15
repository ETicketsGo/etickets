'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useParams, useRouter } from 'next/navigation';
import Link from 'next/link';
import { Eye, Footprints, MapPin, Pencil, PencilRuler } from 'lucide-react';
import { useState } from 'react';
import {
  api,
  Badge,
  ButtonLink,
  Button,
  Card,
  Dialog,
  EmptyState,
  ErrorState,
  Input,
  PageHeader,
  Select,
  Skeleton,
  StatusPill,
  dateTime,
  errorMessage,
  money,
  type LayoutTemplateFitMode,
  type LayoutTemplateOutline,
  useToast,
  venueAddressLine,
  type BadgeTone,
  type SeatLayoutStatus,
  type SeatLayoutSummary,
  type SpaceDetail,
} from '@eticketsgo/web-kit';
import {
  LAYOUT_GALLERY,
  SPACE_KINDS,
  reconcileSeats,
  spaceKindOption,
  templatesForSpaceKind,
  type LayoutGalleryOption,
  type SpaceKind,
  type VenueTemplateKey,
} from '@eticketsgo/shared-types';
import { LayoutTemplateGallery } from '@/components/layout-template-gallery';
import { SeatCountSummary } from '@/components/seat-count-summary';
import { LayoutSizeChoice, defaultSizeMode } from '@/components/layout-size-choice';
import { priceToMinor, venueCurrency } from '../../venue-spaces';

/**
 * A space's own page: what it is, where it is, and the seat layouts it sells from.
 *
 * -- WHY ONE PAGE ---------------------------------------------------------------------------
 * A space used to have two kinds of page. A cinema screen lived under its cinema, a hall under
 * `/spaces`, and neither said which venue it was in or what kind of place it was. Adding a
 * layout re-asked "What kind of space is this?", offered an 11,712-seat concert arena to a
 * cinema screen, priced it with no currency and kept its button disabled until a box below
 * was filled. This page knows the space - its kind, chosen once when it was made, and its
 * venue, whose currency it prices in - so it offers only the layouts that fit.
 *
 * -- WHAT CANNOT BE BROKEN FROM HERE --------------------------------------------------------
 * Published layouts are frozen (sold seats point at them). A space with sessions cannot be
 * deleted - the API refuses, and the page says so before anybody tries - only taken out of
 * use, which stops new scheduling and leaves every sold ticket as it is.
 */

const STATUS_TONE: Record<SeatLayoutStatus, BadgeTone> = {
  DRAFT: 'warning',
  PUBLISHED: 'success',
  ARCHIVED: 'neutral',
};

const STATUS_WORD: Record<SeatLayoutStatus, string> = {
  DRAFT: 'Draft',
  PUBLISHED: 'Published',
  ARCHIVED: 'Archived',
};

const STATUS_HINT: Record<SeatLayoutStatus, string> = {
  DRAFT: 'Change it with Edit. Sessions cannot use it until you publish it.',
  PUBLISHED: 'Frozen. Sessions can use it.',
  ARCHIVED: 'Retired. Sessions that already use it keep working.',
};

const SPACE_STATUS: Record<string, { word: string; tone: 'success' | 'warning' | 'neutral' }> = {
  ACTIVE: { word: 'In use', tone: 'success' },
  MAINTENANCE: { word: 'Maintenance', tone: 'warning' },
  INACTIVE: { word: 'Out of use', tone: 'neutral' },
};

export default function SpacePage() {
  const { screenId } = useParams<{ screenId: string }>();
  const qc = useQueryClient();
  const router = useRouter();
  const toast = useToast();
  const base = `/organizer/spaces/${screenId}`;

  const spaceQ = useQuery({
    queryKey: ['space', screenId],
    queryFn: () => api.venues.space(screenId),
  });
  const layoutsQ = useQuery({
    queryKey: ['screen', screenId, 'layouts'],
    queryFn: () => api.theaterOps.layouts(screenId),
  });

  const space = spaceQ.data;
  const kind = space?.kind ?? null;
  const fits = templatesForSpaceKind(kind);
  const currency = venueCurrency(space?.venue?.country);
  const priceLabel = currency ? `Cheapest seat (${currency.symbol})` : 'Cheapest seat';
  const priceHint = currency
    ? `In ${currency.code}, the currency of the venue's country. Other ticket categories are priced up from this. Change any later.`
    : "This venue has no country yet, so its currency is not known. Set the venue's country in Venues & seating first.";
  /** Rows of seats can be drawn by hand; block venues and standing floors cannot. */
  const canDraw = kind === null || kind === 'CINEMA_SCREEN' || kind === 'SEATED_HALL';

  const refresh = () => {
    void qc.invalidateQueries({ queryKey: ['screen', screenId, 'layouts'] });
    void qc.invalidateQueries({ queryKey: ['space', screenId] });
  };

  const [publishing, setPublishing] = useState<SeatLayoutSummary | null>(null);
  const [archiving, setArchiving] = useState<SeatLayoutSummary | null>(null);
  const [effectiveFrom, setEffectiveFrom] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [compareTo, setCompareTo] = useState<string | null>(null);
  /** The "start a draft from a shape" dialog, for a draft that already exists. */
  const [templating, setTemplating] = useState<SeatLayoutSummary | null>(null);
  const [template, setTemplate] = useState<VenueTemplateKey | null>(null);
  const [templateOutline, setTemplateOutline] = useState<LayoutTemplateOutline | null>(null);
  const [templateSize, setTemplateSize] = useState<LayoutTemplateFitMode | null>(null);
  const [basePrice, setBasePrice] = useState('');
  const [priceProblem, setPriceProblem] = useState<string | null>(null);
  /** The "new layout" dialog: open, which card, and what to call it. */
  const [creating, setCreating] = useState(false);
  const [newOption, setNewOption] = useState<LayoutGalleryOption | null>(null);
  const [newName, setNewName] = useState('');
  const [newOutline, setNewOutline] = useState<LayoutTemplateOutline | null>(null);
  /** How many seats to build: exactly the planned number, or the nearest full rows. */
  const [newSize, setNewSize] = useState<LayoutTemplateFitMode | null>(null);
  const [editing, setEditing] = useState(false);
  const [deleting, setDeleting] = useState(false);

  const openCreate = () => {
    setError(null);
    setPriceProblem(null);
    setNewOption(null);
    setNewOutline(null);
    setNewSize(null);
    setNewName('');
    setCreating(true);
  };

  const run = useMutation({
    mutationFn: (fn: () => Promise<unknown>) => fn(),
    onSuccess: () => {
      refresh();
      setPublishing(null);
      setArchiving(null);
      setTemplating(null);
      setError(null);
    },
    // Refusals here carry a policy code and a written explanation; showing the server's
    // sentence is better than inventing one that may not match the actual rule.
    onError: (e) => setError(errorMessage(e)),
  });

  /*
    A new draft from a template, then straight to the buyer preview - checking it there is the
    step before publishing.
  */
  const create = useMutation({
    mutationFn: (basePriceMinor: number) => {
      if (!newOption?.template) throw new Error('Choose a layout first.');
      return api.theaterOps.createLayoutFromTemplate(screenId, {
        template: newOption.template,
        name: newName.trim() || newOption.label,
        basePriceMinor,
        // Built at the size the space was given, the way the person chose to meet it.
        targetSeats: space?.capacity,
        fit: newSize ?? defaultSizeMode(newOutline) ?? undefined,
      });
    },
    onSuccess: (created) => {
      refresh();
      setCreating(false);
      setError(null);
      // Straight to the editor: prices, sections and seats are shaped there before publishing.
      router.push(`${base}/layouts/${created.id}/edit`);
    },
    onError: (e) => setError(errorMessage(e)),
  });

  const submitCreate = () => {
    if (!newOption?.template) {
      setError('Choose a layout first.');
      return;
    }
    const price = priceToMinor(basePrice);
    if ('problem' in price) {
      setPriceProblem(price.problem);
      return;
    }
    create.mutate(price.minor);
  };

  const submitTemplate = () => {
    if (!templating || !template) {
      setError('Choose a layout first.');
      return;
    }
    const price = priceToMinor(basePrice);
    if ('problem' in price) {
      setPriceProblem(price.problem);
      return;
    }
    const id = templating.id;
    run.mutate(() =>
      api.theaterOps.applyVenueTemplate(id, {
        template,
        basePriceMinor: price.minor,
        targetSeats: space?.capacity,
        fit: templateSize ?? defaultSizeMode(templateOutline) ?? undefined,
      }),
    );
  };

  const setStatus = useMutation({
    mutationFn: (status: 'ACTIVE' | 'INACTIVE') => api.cinemas.updateScreen(screenId, { status }),
    onSuccess: (_, status) => {
      toast.push(
        status === 'INACTIVE' ? 'Space taken out of use.' : 'Space back in use.',
        'success',
      );
      refresh();
    },
    onError: (e) => toast.push(errorMessage(e), 'error'),
  });

  const remove = useMutation({
    mutationFn: () => api.cinemas.removeScreen(screenId),
    onSuccess: () => {
      toast.push('Space deleted.', 'success');
      void qc.invalidateQueries({ queryKey: ['venue-spaces'] });
      router.push('/organizer/venues');
    },
    onError: (e) => setError(errorMessage(e)),
  });

  const layouts = layoutsQ.data ?? [];
  const now = new Date();
  const activeId = activeVersion(layouts, now)?.id ?? null;

  const compareQ = useQuery({
    queryKey: ['layout-compare', compareTo],
    queryFn: () => {
      const to = layouts.find((l) => l.id === compareTo)!;
      const from = layouts.find((l) => l.id === to.clonedFromId)!;
      return api.theaterOps.compareLayouts(from.id, to.id);
    },
    enabled: !!compareTo && !!layouts.find((l) => l.id === compareTo)?.clonedFromId,
  });

  if (spaceQ.isError) {
    return (
      <ErrorState message={errorMessage(spaceQ.error)} onRetry={() => void spaceQ.refetch()} />
    );
  }
  if (!space) return <Skeleton className="h-64 w-full" />;

  const kindOption = spaceKindOption(kind);
  const status = SPACE_STATUS[space.status] ?? SPACE_STATUS.ACTIVE;
  const standing = kind === 'STANDING';
  // The shared address line, which drops a city or state typed into the street box as well.
  const where = space.venue ? venueAddressLine(space.venue) : null;

  return (
    <div className="space-y-6">
      <PageHeader
        title={space.name}
        description={`${kindOption?.label ?? 'Space'}${space.venue ? ` at ${space.venue.name}` : ''}`}
        breadcrumbs={[
          { label: 'Venues & seating', href: '/organizer/venues' },
          ...(space.venue ? [{ label: space.venue.name, href: '/organizer/venues' }] : []),
          { label: space.name },
        ]}
        action={
          standing ? undefined : (
            <Button onClick={openCreate} data-testid="new-layout">
              {layouts.length === 0 ? 'Add a seat layout' : 'New layout'}
            </Button>
          )
        }
      />

      {/*
        THE SPACE, said once. Where it is comes from the venue and is shown, never asked. A cinema
        screen names its cinema, because films are scheduled per cinema - the one place an
        operator still needs it.
      */}
      <Card padding="sm">
        {/* Stacked on a phone, so the facts get the full width instead of a third of it. */}
        <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
          <dl className="grid min-w-0 flex-1 gap-x-6 gap-y-2 text-[0.9375rem] sm:grid-cols-2">
            <div>
              <dt className="text-caption text-text-muted">Kind of space</dt>
              <dd className="font-medium text-text-primary" data-testid="space-kind">
                {kindOption?.label ?? 'Not said yet'}
                {space.kind === 'CINEMA_SCREEN' && space.screenType ? ` · ${space.screenType}` : ''}
              </dd>
            </div>
            <div>
              <dt className="text-caption text-text-muted">
                {standing ? 'Holds' : 'Seats (planned)'}
              </dt>
              <dd className="font-medium tabular-nums text-text-primary">
                {space.capacity.toLocaleString()} {standing ? 'people' : ''}
              </dd>
            </div>
            {space.venue ? (
              <div className="sm:col-span-2">
                <dt className="text-caption text-text-muted">Where (from the venue)</dt>
                <dd className="flex items-start gap-1.5 text-text-primary">
                  <MapPin className="mt-1 h-3.5 w-3.5 shrink-0 text-text-muted" aria-hidden />
                  <span className="min-w-0 break-words">
                    <span className="font-medium">{space.venue.name}</span>
                    {where ? `, ${where}` : ''}
                    {space.venue.timezone ? (
                      <span className="text-text-muted"> · {space.venue.timezone}</span>
                    ) : null}
                  </span>
                </dd>
              </div>
            ) : null}
            {space.cinemaId ? (
              <div className="sm:col-span-2">
                <dt className="text-caption text-text-muted">Shows films for</dt>
                <dd className="text-text-primary">
                  <Link
                    href={`/organizer/cinemas/${space.cinemaId}`}
                    className="font-medium text-action-primary underline-offset-2 hover:underline"
                  >
                    {space.cinemaName ?? 'Cinema'}
                  </Link>
                  <span className="text-text-muted"> · </span>
                  <Link
                    href={`/organizer/cinemas/${space.cinemaId}/schedule`}
                    className="font-medium text-action-primary underline-offset-2 hover:underline"
                  >
                    Film schedule
                  </Link>
                </dd>
              </div>
            ) : null}
            <div className="sm:col-span-2">
              <dt className="text-caption text-text-muted">Sessions</dt>
              <dd className="text-text-primary">
                {space.sessions === 0
                  ? 'Not used by any session yet.'
                  : `Used by ${space.sessions} session${space.sessions === 1 ? '' : 's'}${
                      space.upcomingSessions > 0 ? `, ${space.upcomingSessions} still to come` : ''
                    }.`}
              </dd>
            </div>
          </dl>
          <div className="flex flex-wrap items-center gap-2">
            <StatusPill tone={status.tone} size="sm">
              {status.word}
            </StatusPill>
            <Button variant="outline" size="sm" onClick={() => setEditing(true)}>
              <Pencil className="h-3.5 w-3.5" aria-hidden />
              Edit space
            </Button>
          </div>
        </div>
      </Card>

      {standing ? (
        /*
          A STANDING space has no seat map, and that is the setup - not a missing step. It used
          to be reachable only as a "General admission" card inside the layout gallery, whose
          message was "this needs no layout".
        */
        <Card>
          <div className="flex items-start gap-3">
            <Footprints className="mt-0.5 h-5 w-5 shrink-0 text-action-primary" aria-hidden />
            <div className="space-y-2 text-[0.9375rem]">
              <p className="font-semibold text-text-primary">General admission. No seat map.</p>
              <p className="text-text-secondary">
                Buyers do not choose a seat. When you create an event at{' '}
                {space.venue?.name ?? 'this venue'}, choose free or paid tickets and set how many to
                sell, up to {space.capacity.toLocaleString()}, the number this space holds.
              </p>
              <ButtonLink size="sm" variant="secondary" href="/organizer/events/new">
                Create an event
              </ButtonLink>
            </div>
          </div>
        </Card>
      ) : null}

      {!standing || layouts.length > 0 ? (
        <section className="space-y-3" aria-labelledby="layouts-heading">
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <h2 id="layouts-heading" className="text-title font-semibold text-text-primary">
              Seat layouts
            </h2>
            <p className="text-caption text-text-muted">
              A published layout is frozen, because sold seats point at it. To change it, clone it,
              edit the new draft, then publish.
            </p>
          </div>

          {layoutsQ.isPending ? (
            <Skeleton className="h-48 w-full" />
          ) : layoutsQ.isError ? (
            <ErrorState
              message={errorMessage(layoutsQ.error)}
              onRetry={() => void layoutsQ.refetch()}
            />
          ) : layouts.length === 0 ? (
            <EmptyState
              title="No seat layout yet"
              hint="Until it has one, sessions here cannot sell numbered seats. Start from a layout that fits this space, then publish it."
              action={<Button onClick={openCreate}>Add a seat layout</Button>}
              secondaryAction={
                canDraw ? (
                  <ButtonLink variant="outline" href={`${base}/seatmap`}>
                    Draw the rows yourself
                  </ButtonLink>
                ) : undefined
              }
            />
          ) : (
            <ul className="space-y-3">
              {layouts.map((l) => (
                /* One unambiguous boundary per version, so an assertion about v1 cannot
                   accidentally match v2's badge. */
                <li key={l.id} data-testid={`layout-${l.version}`}>
                  <Card padding="sm">
                    <div className="flex flex-wrap items-start gap-x-4 gap-y-2">
                      <span className="font-mono text-sm font-semibold tabular-nums">
                        v{l.version}
                      </span>
                      <span className="min-w-[8rem] flex-1">
                        <span className="font-medium">{l.name ?? 'Layout'}</span>
                        <span className="block text-caption text-text-muted">
                          {STATUS_HINT[l.status]}
                        </span>
                      </span>

                      <Badge tone={STATUS_TONE[l.status]}>{STATUS_WORD[l.status]}</Badge>
                      {l.id === activeId ? <Badge tone="info">In use today</Badge> : null}
                      {isFuture(l, now) ? (
                        <Badge tone="warning">Starts {dateTime(l.effectiveFrom as string)}</Badge>
                      ) : null}

                      <span className="text-sm text-text-muted">
                        {/* The shared rule: house seats drawn in the layout are not bookable. */}
                        {(l.kindCounts
                          ? reconcileSeats(l.kindCounts).bookable
                          : l.capacity
                        ).toLocaleString()}{' '}
                        bookable seats
                        {l.futureShows > 0
                          ? ` · ${l.futureShows} upcoming session${l.futureShows === 1 ? '' : 's'}`
                          : ''}
                        {l.historicalShows > 0 ? ` · ${l.historicalShows} past` : ''}
                      </span>

                      <span className="flex flex-wrap gap-2">
                        {l.status === 'DRAFT' ? (
                          <ButtonLink href={`${base}/layouts/${l.id}/edit`}>
                            <PencilRuler className="mr-1.5 h-4 w-4" aria-hidden />
                            Edit
                            {/* ButtonLink takes no aria-label, so the version is in the name here. */}
                            <span className="sr-only"> version {l.version}</span>
                          </ButtonLink>
                        ) : null}
                        <ButtonLink
                          variant="outline"
                          href={`${base}/layouts/${l.id}/preview`}
                          aria-label={`Preview version ${l.version} as a buyer`}
                        >
                          <Eye className="mr-1.5 h-4 w-4" aria-hidden />
                          Preview as buyer
                        </ButtonLink>
                        {l.status === 'DRAFT' ? (
                          <Button
                            variant="outline"
                            disabled={run.isPending}
                            aria-label={`Publish version ${l.version}`}
                            onClick={() => {
                              setEffectiveFrom('');
                              setError(null);
                              setPublishing(l);
                            }}
                          >
                            Publish
                          </Button>
                        ) : null}
                        <Button
                          variant="secondary"
                          disabled={run.isPending}
                          aria-label={`Clone version ${l.version} as a new draft`}
                          onClick={() => run.mutate(() => api.theaterOps.cloneLayout(l.id))}
                        >
                          Clone
                        </Button>
                        {l.status === 'DRAFT' ? (
                          <Button
                            variant="outline"
                            disabled={run.isPending}
                            aria-label={`Rebuild version ${l.version} from a layout`}
                            onClick={() => {
                              setError(null);
                              setPriceProblem(null);
                              setTemplate(null);
                              setTemplating(l);
                            }}
                          >
                            Rebuild from a layout
                          </Button>
                        ) : null}
                        {l.status === 'PUBLISHED' ? (
                          <Button
                            variant="secondary"
                            disabled={run.isPending}
                            aria-label={`Archive version ${l.version}`}
                            onClick={() => {
                              setError(null);
                              setArchiving(l);
                            }}
                          >
                            Archive
                          </Button>
                        ) : null}
                        {l.clonedFromId ? (
                          <Button
                            variant="outline"
                            aria-label={`Compare version ${l.version} with the version it was cloned from`}
                            onClick={() => setCompareTo(compareTo === l.id ? null : l.id)}
                          >
                            Compare
                          </Button>
                        ) : null}
                      </span>
                    </div>

                    {l.kindCounts && l.kindCounts.length > 0 ? (
                      <div className="mt-2">
                        <SeatCountSummary counts={reconcileSeats(l.kindCounts)} compact />
                      </div>
                    ) : null}

                    {compareTo === l.id ? (
                      <div className="mt-3 border-t border-border pt-3">
                        {compareQ.isPending ? (
                          <Skeleton className="h-16 w-full" />
                        ) : compareQ.data ? (
                          <Comparison data={compareQ.data} />
                        ) : null}
                      </div>
                    ) : null}
                  </Card>
                </li>
              ))}
            </ul>
          )}
        </section>
      ) : null}

      {error && !publishing && !archiving && !creating && !templating && !deleting ? (
        <p role="alert" className="rounded-md bg-status-error/10 p-3 text-sm">
          {error}
        </p>
      ) : null}

      {editing ? (
        <EditSpaceDialog
          space={space}
          onClose={() => setEditing(false)}
          onSaved={() => {
            setEditing(false);
            refresh();
          }}
          onStatus={(s) => setStatus.mutate(s)}
          statusPending={setStatus.isPending}
          onDelete={() => {
            setEditing(false);
            setError(null);
            setDeleting(true);
          }}
        />
      ) : null}

      {deleting ? (
        <Dialog
          open
          onClose={() => setDeleting(false)}
          title={`Delete ${space.name}?`}
          footer={
            <>
              <Button variant="outline" onClick={() => setDeleting(false)}>
                Cancel
              </Button>
              <Button loading={remove.isPending} onClick={() => remove.mutate()}>
                Delete space
              </Button>
            </>
          }
        >
          <div className="space-y-3 text-sm">
            <p>
              This removes {space.name} and its seat layouts. No session uses it, so nothing that
              was sold is affected. This cannot be undone.
            </p>
            {error ? (
              <p role="alert" className="rounded-md bg-status-error/10 p-3">
                {error}
              </p>
            ) : null}
          </div>
        </Dialog>
      ) : null}

      {publishing ? (
        <Dialog
          open
          onClose={() => setPublishing(null)}
          title={`Publish v${publishing.version}`}
          footer={
            <>
              <Button
                variant="outline"
                onClick={() => setPublishing(null)}
                disabled={run.isPending}
              >
                Cancel
              </Button>
              <Button
                loading={run.isPending}
                onClick={() =>
                  run.mutate(() =>
                    api.theaterOps.publishLayout(
                      publishing.id,
                      effectiveFrom ? new Date(effectiveFrom).toISOString() : undefined,
                    ),
                  )
                }
              >
                Publish
              </Button>
            </>
          }
        >
          <div className="space-y-4">
            <p className="text-sm">
              Publishing freezes this version. To change it afterwards, clone it.
            </p>
            {publishing.suggestedPrices && publishing.suggestedPrices.length > 0 ? (
              <div role="note" className="space-y-2 rounded-md bg-status-warning/10 p-3 text-sm">
                <p>
                  These prices were worked out by the template, not typed by you. Publishing
                  confirms them:
                </p>
                <ul className="list-disc pl-5">
                  {publishing.suggestedPrices.map((c) => (
                    <li key={c.name}>
                      {c.name}:{' '}
                      <span className="tabular-nums">
                        {money(c.priceMinor, currency?.code ?? 'INR')}
                      </span>
                    </li>
                  ))}
                </ul>
                <Link
                  href={`${base}/layouts/${publishing.id}/edit`}
                  className="font-medium text-action-primary underline-offset-2 hover:underline"
                >
                  Change the prices first
                </Link>
              </div>
            ) : null}
            <Input
              id="eff-from"
              label="Takes effect from (optional)"
              type="datetime-local"
              value={effectiveFrom}
              onChange={(e) => setEffectiveFrom(e.target.value)}
              hint="Leave blank to use it now. A future date applies only to sessions that start on or after it. Sessions already scheduled keep the layout they were built with."
            />
            {error ? (
              <p role="alert" className="rounded-md bg-status-error/10 p-3 text-sm">
                {error}
              </p>
            ) : null}
          </div>
        </Dialog>
      ) : null}

      {templating ? (
        <Dialog
          open
          onClose={() => setTemplating(null)}
          title={`Rebuild v${templating.version} from a layout`}
          footer={
            <>
              <Button variant="outline" onClick={() => setTemplating(null)}>
                Cancel
              </Button>
              <Button loading={run.isPending} onClick={submitTemplate}>
                Rebuild draft
              </Button>
            </>
          }
        >
          <div className="space-y-4">
            <p className="text-sm">
              This replaces everything in the draft. Pick the layout closest to your space and
              adjust it afterwards.
            </p>
            <PriceField
              label={priceLabel}
              hint={priceHint}
              value={basePrice}
              problem={priceProblem}
              onChange={(v) => {
                setBasePrice(v);
                setPriceProblem(null);
              }}
            />
            <LayoutTemplateGallery
              templates={fits}
              targetSeats={space.capacity}
              selectedId={template ? galleryIdFor(template) : null}
              onChoose={(option, outline) => {
                if (option.template) setTemplate(option.template);
                setTemplateOutline(outline);
                setTemplateSize(null);
                setError(null);
              }}
            />
            <LayoutSizeChoice
              outline={templateOutline}
              value={templateSize}
              onChange={setTemplateSize}
              planned={space.capacity}
            />
            {error ? (
              <p role="alert" className="rounded-md bg-status-error/10 p-3 text-sm">
                {error}
              </p>
            ) : null}
          </div>
        </Dialog>
      ) : null}

      {creating ? (
        <Dialog
          open
          onClose={() => setCreating(false)}
          title="Add a seat layout"
          footer={
            <>
              <Button variant="outline" onClick={() => setCreating(false)}>
                Cancel
              </Button>
              <Button loading={create.isPending} onClick={submitCreate}>
                Build draft
              </Button>
            </>
          }
        >
          <div className="space-y-4">
            {/*
              Name and price FIRST, then the pictures. The price box used to sit below six large
              cards, and the button stayed disabled until it was found and filled.
            */}
            <p className="text-sm">
              This builds a draft you can then change seat by seat. Nothing changes for buyers until
              you publish it.
              {kindOption
                ? ` Showing the layouts that fit a ${kindOption.label.toLowerCase()}.`
                : ''}
            </p>
            <div className="grid gap-4 sm:grid-cols-2">
              <PriceField
                label={priceLabel}
                hint={priceHint}
                value={basePrice}
                problem={priceProblem}
                onChange={(v) => {
                  setBasePrice(v);
                  setPriceProblem(null);
                }}
              />
              <Input
                id="new-layout-name"
                label="Layout name"
                hint={
                  kind === 'ARENA'
                    ? 'One space can have several, such as Basketball and Concert.'
                    : 'Shown to you, not to buyers.'
                }
                value={newName}
                onChange={(e) => setNewName(e.target.value)}
              />
            </div>
            <LayoutTemplateGallery
              templates={fits}
              targetSeats={space.capacity}
              selectedId={newOption?.id ?? null}
              onChoose={(option, outline) => {
                setNewOption(option);
                setNewOutline(outline);
                setNewSize(null);
                setError(null);
                if (!newName.trim() || LAYOUT_GALLERY.some((g) => g.label === newName.trim())) {
                  setNewName(option.label);
                }
              }}
            />
            <LayoutSizeChoice
              outline={newOutline}
              value={newSize}
              onChange={setNewSize}
              planned={space.capacity}
            />
            {canDraw ? (
              <p className="text-caption text-text-secondary">
                None of these fits?{' '}
                <Link
                  href={`${base}/seatmap`}
                  className="font-medium text-action-primary underline-offset-2 hover:underline"
                >
                  Draw the rows yourself
                </Link>
                .
              </p>
            ) : null}
            {error ? (
              <p role="alert" className="rounded-md bg-status-error/10 p-3 text-sm">
                {error}
              </p>
            ) : null}
          </div>
        </Dialog>
      ) : null}

      {archiving ? (
        <Dialog
          open
          onClose={() => setArchiving(null)}
          title={`Archive v${archiving.version}`}
          footer={
            <>
              <Button variant="outline" onClick={() => setArchiving(null)} disabled={run.isPending}>
                Cancel
              </Button>
              <Button
                loading={run.isPending}
                onClick={() => run.mutate(() => api.theaterOps.archiveLayout(archiving.id))}
              >
                Archive version
              </Button>
            </>
          }
        >
          <div className="space-y-3 text-sm">
            <p>
              Archiving retires this version from new sessions. It is never deleted, and sessions
              already using it keep working: they hold their own seats.
            </p>
            {archiving.futureShows > 0 ? (
              <p role="alert" className="rounded-md bg-status-warning/10 p-3">
                {archiving.futureShows} upcoming session
                {archiving.futureShows === 1 ? '' : 's'} still use this layout. Archiving is refused
                until they are moved or cancelled.
              </p>
            ) : null}
            {error ? (
              <p role="alert" className="rounded-md bg-status-error/10 p-3">
                {error}
              </p>
            ) : null}
          </div>
        </Dialog>
      ) : null}
    </div>
  );
}

function PriceField({
  label,
  hint,
  value,
  problem,
  onChange,
}: {
  label: string;
  hint: string;
  value: string;
  problem: string | null;
  onChange: (value: string) => void;
}) {
  return (
    <Input
      id="layout-price"
      label={label}
      type="number"
      min={0}
      inputMode="decimal"
      hint={hint}
      value={value}
      onChange={(e) => onChange(e.target.value)}
      error={problem ?? undefined}
    />
  );
}

/**
 * Rename the space, change its size or kind, take it out of use - or delete it, only when no
 * session has ever used it.
 */
function EditSpaceDialog({
  space,
  onClose,
  onSaved,
  onStatus,
  statusPending,
  onDelete,
}: {
  space: SpaceDetail;
  onClose: () => void;
  onSaved: () => void;
  onStatus: (status: 'ACTIVE' | 'INACTIVE') => void;
  statusPending: boolean;
  onDelete: () => void;
}) {
  const toast = useToast();
  const [name, setName] = useState(space.name);
  const [capacity, setCapacity] = useState(String(space.capacity));
  const [kind, setKind] = useState<SpaceKind | ''>(space.kind ?? '');
  const [problem, setProblem] = useState<string | null>(null);
  const isScreen = !!space.cinemaId;
  // A cinema's screen is a cinema screen; nothing else can claim to be one.
  const kinds = isScreen
    ? SPACE_KINDS.filter((k) => k.kind === 'CINEMA_SCREEN')
    : SPACE_KINDS.filter((k) => k.kind !== 'CINEMA_SCREEN');

  const save = useMutation({
    mutationFn: () =>
      api.cinemas.updateScreen(space.id, {
        name: name.trim(),
        capacity: Number(capacity),
        ...(kind && kind !== space.kind ? { kind } : {}),
      }),
    onSuccess: () => {
      toast.push('Space updated.', 'success');
      onSaved();
    },
    onError: (e) => setProblem(errorMessage(e)),
  });

  const submit = () => {
    const n = Number(capacity);
    if (!name.trim()) return setProblem('Give the space a name.');
    if (!Number.isInteger(n) || n < 1) return setProblem('Capacity must be a whole number.');
    setProblem(null);
    save.mutate();
  };

  const outOfUse = space.status === 'INACTIVE';

  return (
    <Dialog
      open
      onClose={onClose}
      title={`Edit ${space.name}`}
      footer={
        <>
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button loading={save.isPending} onClick={submit}>
            Save changes
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <Input
          id="edit-space-name"
          label="Space name"
          value={name}
          onChange={(e) => setName(e.target.value)}
        />
        <Select
          id="edit-space-kind"
          label="Kind of space"
          value={kind}
          disabled={isScreen}
          onChange={(e) => setKind(e.target.value as SpaceKind)}
          hint={
            isScreen
              ? 'A screen in a cinema stays a cinema screen.'
              : 'Changes which layouts are offered. Layouts already published are kept.'
          }
        >
          {!kind ? <option value="">Not said yet</option> : null}
          {kinds.map((k) => (
            <option key={k.kind} value={k.kind}>
              {k.label}
            </option>
          ))}
        </Select>
        <Input
          id="edit-space-capacity"
          label={kind === 'STANDING' ? 'How many people can it hold?' : 'About how many seats?'}
          type="number"
          min={1}
          value={capacity}
          onChange={(e) => setCapacity(e.target.value)}
        />
        {problem ? (
          <p role="alert" className="rounded-md bg-status-error/10 p-3 text-sm">
            {problem}
          </p>
        ) : null}

        <div className="space-y-2 border-t border-border pt-4 text-sm">
          <p className="font-medium text-text-primary">
            {outOfUse ? 'Out of use' : 'Stop using it'}
          </p>
          <p className="text-text-secondary">
            {outOfUse
              ? 'No new session can be scheduled here. Sessions already scheduled are not changed.'
              : 'Taking it out of use stops new sessions here. Sessions already scheduled, and every ticket sold for them, are not changed.'}
          </p>
          <Button
            variant="outline"
            size="sm"
            loading={statusPending}
            onClick={() => onStatus(outOfUse ? 'ACTIVE' : 'INACTIVE')}
          >
            {outOfUse ? 'Put back in use' : 'Take out of use'}
          </Button>
          {space.sessions === 0 ? (
            <div className="pt-2">
              <Button variant="ghost" size="sm" className="text-status-error" onClick={onDelete}>
                Delete space
              </Button>
            </div>
          ) : (
            <p className="text-caption text-text-muted">
              It cannot be deleted: {space.sessions} session{space.sessions === 1 ? '' : 's'} used
              it, and their tickets point at its seats.
            </p>
          )}
        </div>
      </div>
    </Dialog>
  );
}

/** Which gallery card stands for a template key, so the picker shows the current choice. */
function galleryIdFor(key: VenueTemplateKey): string {
  return LAYOUT_GALLERY.find((g) => g.template === key)?.id ?? key.toLowerCase();
}

/**
 * The version in effect right now.
 *
 * Mirrors the server's rule - latest published whose effective date has passed - purely to
 * label a row. Scheduling never uses this; the API decides.
 */
function activeVersion(layouts: SeatLayoutSummary[], now: Date): SeatLayoutSummary | null {
  const candidates = layouts
    .filter((l) => l.status === 'PUBLISHED')
    .filter((l) => new Date(l.effectiveFrom ?? l.publishedAt ?? l.createdAt) <= now);
  if (candidates.length === 0) return null;
  return candidates.reduce((best, l) =>
    new Date(l.effectiveFrom ?? l.publishedAt ?? l.createdAt) >
    new Date(best.effectiveFrom ?? best.publishedAt ?? best.createdAt)
      ? l
      : best,
  );
}

function isFuture(l: SeatLayoutSummary, now: Date): boolean {
  return l.status === 'PUBLISHED' && !!l.effectiveFrom && new Date(l.effectiveFrom) > now;
}

/** What changed between a draft and the version it came from. */
function Comparison({ data }: { data: import('@eticketsgo/web-kit').LayoutComparison }) {
  const nothing =
    data.addedSeats.length === 0 &&
    data.removedSeats.length === 0 &&
    data.changedSeats.length === 0;

  return (
    <div className="space-y-2 text-sm">
      <p className="font-medium">
        v{data.from.version} to v{data.to.version}
      </p>
      {nothing ? (
        <p className="text-text-muted">Identical to the version it was cloned from.</p>
      ) : (
        <ul className="space-y-1 text-text-secondary">
          {data.addedSeats.length > 0 ? (
            <li>Added: {data.addedSeats.map((s) => s.seat).join(', ')}</li>
          ) : null}
          {data.removedSeats.length > 0 ? (
            <li>Removed: {data.removedSeats.map((s) => s.seat).join(', ')}</li>
          ) : null}
          {data.changedSeats.map((s) => (
            <li key={s.seat}>
              {s.seat}: {s.from?.categoryName}/{s.from?.kind} to {s.to?.categoryName}/{s.to?.kind}
            </li>
          ))}
        </ul>
      )}
      <p className="text-caption text-text-muted">
        Capacity change: {data.capacityDelta > 0 ? '+' : ''}
        {data.capacityDelta} · {data.unchangedCount} seats unchanged
      </p>
    </div>
  );
}
