'use client';

import { useQuery } from '@tanstack/react-query';
import { useParams } from 'next/navigation';
import { useMemo, useState } from 'react';
import { Eye } from 'lucide-react';
import {
  api,
  Badge,
  BuyerSeatLegend,
  BuyerSeatMap,
  ButtonLink,
  Card,
  EmptyState,
  ErrorState,
  PageHeader,
  Skeleton,
  VenueMap,
  currencyForCountry,
  errorMessage,
  money,
  type SeatLayout,
  type SeatLayoutPreview,
  type VenueOverview,
} from '@eticketsgo/web-kit';
import { reconcileSeats } from '@eticketsgo/shared-types';
import { SeatCountSummary } from '@/components/seat-count-summary';

/**
 * Preview as buyer: a layout drawn by the components a buyer's seat page uses.
 *
 * ── WHY THE BUYER'S OWN COMPONENTS ────────────────────────────────────────────────
 * The console's own drawings of a room are diagrams for the person building it. What matters
 * before anything is sold is what the BUYER will see: whether the aisle reads as an aisle,
 * whether a wheelchair space is findable, whether the blocks of an arena sit where the doors
 * are. A look-alike drawing would answer a different question. So this renders `BuyerSeatMap`
 * for a grid and `VenueMap` plus one block's seats for a sectioned venue - the storefront's
 * components - fed by `/seat-layouts/:id/preview`, which returns the public read's shape.
 *
 * ── NOTHING CAN BE BOOKED ─────────────────────────────────────────────────────────
 * There is no session behind a layout, so there is no inventory to hold: every seat shows as
 * available, tapping one does nothing, and there is no basket or pay button. Prices are the
 * ticket categories' base prices; a session may sell above or below them.
 */

const NO_SEATS: ReadonlySet<string> = new Set();

/** The two shapes a preview can take, told apart by `view` as the buyer's page does. */
const asSeats = (p: SeatLayoutPreview | undefined): SeatLayout | null =>
  p && p.view === 'seats' ? (p as SeatLayout) : null;
const asOverview = (p: SeatLayoutPreview | undefined): VenueOverview | null =>
  p && p.view === 'overview' ? (p as VenueOverview) : null;
const KIND_LABEL: Record<string, string> = {
  WHEELCHAIR: 'Wheelchair space',
  COMPANION: 'Companion seat',
};

export default function LayoutPreviewPage() {
  // `id` is absent on /organizer/spaces/<screenId>/...: a space that is not a cinema screen.
  const {
    id: cinemaId,
    screenId,
    layoutId,
  } = useParams<{
    id?: string;
    screenId: string;
    layoutId: string;
  }>();
  const [sectionId, setSectionId] = useState<string | null>(null);

  const previewQ = useQuery({
    queryKey: ['layout-preview', layoutId],
    queryFn: () => api.theaterOps.previewLayout(layoutId),
  });
  const data = previewQ.data;
  const isOverview = data?.view === 'overview';
  const blockQ = useQuery({
    queryKey: ['layout-preview', layoutId, sectionId],
    queryFn: () => api.theaterOps.previewLayout(layoutId, sectionId as string),
    enabled: isOverview && !!sectionId,
  });

  const currency = currencyForCountry(data?.country) ?? 'INR';
  const formatMinor = (minor: number) => money(minor, currency);
  const counts = useMemo(() => reconcileSeats(data?.preview.kindCounts ?? []), [data]);
  const layoutsHref = cinemaId
    ? `/organizer/cinemas/${cinemaId}/screens/${screenId}/layouts`
    : `/organizer/spaces/${screenId}/layouts`;

  const overview = asOverview(data);
  const seatsView = asSeats(data) ?? asSeats(blockQ.data);
  const hasAccessible = !!seatsView?.sections.some((s) =>
    s.rows.some((r) => r.seats.some((seat) => seat.kind in KIND_LABEL)),
  );
  const activeBlock = overview?.sections.find((s) => s.id === sectionId);

  return (
    <div className="mx-auto max-w-4xl space-y-6">
      <PageHeader
        title="Preview as buyer"
        description={
          data ? `${data.preview.name ?? 'Layout'}, version ${data.preview.version}` : undefined
        }
        breadcrumbs={[
          { label: 'Venues & spaces', href: '/organizer/venues' },
          { label: 'Layouts', href: layoutsHref },
          { label: 'Preview as buyer' },
        ]}
        action={
          <ButtonLink variant="outline" href={layoutsHref}>
            Back to layouts
          </ButtonLink>
        }
      />

      <div
        role="note"
        data-testid="preview-banner"
        className="flex items-start gap-2 rounded-md border border-border bg-tint-primary px-3 py-2.5 text-sm text-text-primary"
      >
        <Eye className="mt-0.5 h-4 w-4 shrink-0 text-action-primary" aria-hidden />
        <span>
          This is what buyers see for this layout. Nothing here can be booked. Prices are the base
          price of each ticket category; a session can sell above or below them.
          {data?.preview.status === 'DRAFT'
            ? ' This layout is a draft: buyers see nothing until you publish it.'
            : ''}
        </span>
      </div>

      {previewQ.isPending ? (
        <Skeleton className="h-96 w-full" />
      ) : previewQ.isError || !data ? (
        <ErrorState
          message={errorMessage(previewQ.error)}
          onRetry={() => void previewQ.refetch()}
        />
      ) : (
        <>
          <SeatCountSummary counts={counts} />

          <Card title="Ticket categories">
            <ul className="flex flex-wrap gap-x-5 gap-y-2 text-sm text-text-secondary">
              {data.categories.map((c) => (
                <li key={c.id} className="flex items-center gap-1.5">
                  <span
                    aria-hidden
                    className="h-3 w-3 rounded-full border border-border"
                    style={c.colorHex ? { backgroundColor: c.colorHex } : undefined}
                  />
                  {c.name}: <span className="tabular-nums">{formatMinor(c.priceMinor)}</span>
                </li>
              ))}
            </ul>
            <p className="mt-2 text-caption text-text-muted">
              A ticket category is a price, not a place in the room. Status:{' '}
              <Badge tone={data.preview.status === 'PUBLISHED' ? 'success' : 'warning'}>
                {data.preview.status}
              </Badge>
            </p>
          </Card>

          {counts.positions === 0 ? (
            <EmptyState
              title="This layout has no seats yet"
              hint="Build it from a template or the seat map generator, then preview it again."
            />
          ) : overview ? (
            <div className="grid grid-cols-1 gap-6 lg:grid-cols-2 [&>*]:min-w-0">
              <Card title="Choose your area">
                <VenueMap
                  focal={overview.focal}
                  sections={overview.sections}
                  onSelect={setSectionId}
                  formatPrice={formatMinor}
                  activeSectionId={sectionId}
                  pendingSectionId={blockQ.isFetching ? sectionId : null}
                />
              </Card>
              <Card title={activeBlock ? activeBlock.name : 'Seats in a block'}>
                {!sectionId ? (
                  <p className="text-sm text-text-muted">
                    Choose a block on the map to see its seats as a buyer does.
                  </p>
                ) : blockQ.isPending ? (
                  <Skeleton className="h-64 w-full" />
                ) : blockQ.isError ? (
                  <ErrorState
                    message={errorMessage(blockQ.error)}
                    onRetry={() => void blockQ.refetch()}
                  />
                ) : seatsView ? (
                  <div className="space-y-3">
                    <BuyerSeatMap
                      layout={seatsView}
                      selected={NO_SEATS}
                      stranded={NO_SEATS}
                      onTap={() => undefined}
                      formatMinor={formatMinor}
                      seatStatusLabel={(status) => status.toLowerCase()}
                      kindLabel={(kind) => KIND_LABEL[kind] ?? null}
                    />
                    <BuyerSeatLegend
                      hasSold={false}
                      hasHeld={false}
                      hasAccessible={hasAccessible}
                    />
                  </div>
                ) : null}
              </Card>
            </div>
          ) : seatsView ? (
            <Card title="Select seats">
              <div className="space-y-3">
                <BuyerSeatMap
                  layout={seatsView}
                  selected={NO_SEATS}
                  stranded={NO_SEATS}
                  onTap={() => undefined}
                  formatMinor={formatMinor}
                  seatStatusLabel={(status) => status.toLowerCase()}
                  kindLabel={(kind) => KIND_LABEL[kind] ?? null}
                />
                <BuyerSeatLegend hasSold={false} hasHeld={false} hasAccessible={hasAccessible} />
              </div>
            </Card>
          ) : null}
        </>
      )}
    </div>
  );
}
