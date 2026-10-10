'use client';

import { useQuery } from '@tanstack/react-query';
import { useMemo, useState } from 'react';
import { Eye } from 'lucide-react';
import {
  api,
  BuyerSeatLegend,
  BuyerSeatMap,
  Dialog,
  ErrorState,
  Skeleton,
  VenueMap,
  Button,
  currencyForCountry,
  errorMessage,
  money,
  type SeatLayout,
  type SeatLayoutResponse,
  type VenueOverview,
} from '@eticketsgo/web-kit';

const NO_SEATS: ReadonlySet<string> = new Set();
const KIND_LABEL: Record<string, string> = {
  WHEELCHAIR: 'Wheelchair space',
  COMPANION: 'Companion seat',
};
const asSeats = (p: SeatLayoutResponse | undefined): SeatLayout | null =>
  p && p.view === 'seats' ? p : null;
const asOverview = (p: SeatLayoutResponse | undefined): VenueOverview | null =>
  p && p.view === 'overview' ? p : null;

/**
 * The buyer's seat map for one show, read-only, drawn by the storefront's own components.
 *
 * ── WHICH READ ────────────────────────────────────────────────────────────────────
 * For a PUBLISHED event this is the show's own public seat read - the exact map a buyer gets,
 * with seats already sold or held drawn as taken and this show's prices. Before publishing
 * there is no public read (it refuses unpublished events, on purpose), so it falls back to the
 * layout preview: the same version's seats, every one free, at the categories' base prices.
 * The banner says which of the two you are looking at.
 *
 * Nothing can be selected: taps do nothing, and there is no basket or pay button.
 */
export function SeatMapPreviewDialog({
  open,
  onClose,
  sessionId,
  seatMapId,
  live,
  title,
  layoutText,
}: {
  open: boolean;
  onClose: () => void;
  sessionId: string;
  seatMapId: string;
  /** True when the event is published, so the show's own seat read is available. */
  live: boolean;
  /** "Buyer seat map: 12 Nov 2026, 7:00 pm IST". */
  title: string;
  /** "Basketball, version 3", said in the banner. */
  layoutText: string;
}) {
  const [sectionId, setSectionId] = useState<string | null>(null);
  const read = (section?: string) =>
    live
      ? api.publicShows.seats(sessionId, section)
      : (api.theaterOps.previewLayout(seatMapId, section) as Promise<SeatLayoutResponse>);

  const q = useQuery({
    queryKey: ['buyer-seat-preview', live ? sessionId : seatMapId, live],
    queryFn: () => read(),
    enabled: open,
    retry: false,
  });
  const isOverview = q.data?.view === 'overview';
  const blockQ = useQuery({
    queryKey: ['buyer-seat-preview', live ? sessionId : seatMapId, live, sectionId],
    queryFn: () => read(sectionId as string),
    enabled: open && isOverview && !!sectionId,
    retry: false,
  });

  const currency = currencyForCountry(q.data?.country) ?? 'INR';
  const formatMinor = (minor: number) => money(minor, currency);
  const overview = asOverview(q.data);
  const seatsView = asSeats(q.data) ?? asSeats(blockQ.data);
  const flags = useMemo(() => {
    const seats = seatsView?.sections.flatMap((s) => s.rows.flatMap((r) => r.seats)) ?? [];
    return {
      sold: seats.some((s) => s.status === 'SOLD'),
      held: seats.some((s) => s.status === 'HELD'),
      accessible: seats.some((s) => s.kind in KIND_LABEL),
    };
  }, [seatsView]);
  const activeBlock = overview?.sections.find((s) => s.id === sectionId);

  const map = (layout: SeatLayout) => (
    <div className="space-y-3">
      <BuyerSeatMap
        layout={layout}
        selected={NO_SEATS}
        stranded={NO_SEATS}
        onTap={() => undefined}
        formatMinor={formatMinor}
        seatStatusLabel={(status) => status.toLowerCase()}
        kindLabel={(kind) => KIND_LABEL[kind] ?? null}
      />
      <BuyerSeatLegend hasSold={flags.sold} hasHeld={flags.held} hasAccessible={flags.accessible} />
    </div>
  );

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={title}
      size="lg"
      footer={
        <Button variant="outline" onClick={onClose}>
          Close preview
        </Button>
      }
    >
      <div className="space-y-4">
        <p
          role="note"
          className="flex items-start gap-2 rounded-md border border-border bg-tint-primary px-3 py-2.5 text-sm text-text-primary"
        >
          <Eye className="mt-0.5 h-4 w-4 shrink-0 text-action-primary" aria-hidden />
          <span>
            {live
              ? `What a buyer sees for this show now: ${layoutText}, with seats already sold or held shown as taken.`
              : `What buyers will see once the event is published: ${layoutText}. Every seat shows as free and prices are the categories' base prices.`}{' '}
            Nothing here can be booked.
          </span>
        </p>

        {q.isPending ? (
          <Skeleton className="h-72 w-full" />
        ) : q.isError || !q.data ? (
          <ErrorState message={errorMessage(q.error)} onRetry={() => void q.refetch()} />
        ) : overview ? (
          <div className="space-y-4">
            <VenueMap
              focal={overview.focal}
              sections={overview.sections}
              onSelect={setSectionId}
              formatPrice={formatMinor}
              activeSectionId={sectionId}
              pendingSectionId={blockQ.isFetching ? sectionId : null}
            />
            {!sectionId ? (
              <p className="text-sm text-text-muted">
                Choose a block on the map to see its seats as a buyer does.
              </p>
            ) : blockQ.isPending ? (
              <Skeleton className="h-48 w-full" />
            ) : blockQ.isError ? (
              <ErrorState
                message={errorMessage(blockQ.error)}
                onRetry={() => void blockQ.refetch()}
              />
            ) : seatsView ? (
              <section aria-label={activeBlock ? `Seats in ${activeBlock.name}` : 'Seats'}>
                {map(seatsView)}
              </section>
            ) : null}
          </div>
        ) : seatsView ? (
          map(seatsView)
        ) : null}
      </div>
    </Dialog>
  );
}
