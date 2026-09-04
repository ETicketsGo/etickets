'use client';

import { useQuery } from '@tanstack/react-query';
import { api, Card, Skeleton, money } from '@eticketsgo/web-kit';

/**
 * What an exhibitor is told about the order their cinema is priced under.
 *
 * ── EXPLANATORY, NOT ENFORCEMENT ───────────────────────────────────────────────────
 * Every judgement shown here was made by the server, and the server makes it again — on its
 * own — when a booking is placed or a show is published. If this panel were deleted, nothing
 * about what may be sold would change. That is the design: the moment a compliance screen
 * becomes the thing that decides, a client that fails to render it becomes a client that can
 * sell at any price.
 *
 * ── WHAT IS DELIBERATELY NOT SHOWN ─────────────────────────────────────────────────
 * The policy's internal `notes` — "transcribed from a brief, not the order text",
 * "treatment unverified". Useful to whoever configures the platform, and actively misleading
 * to an exhibitor deciding whether they may charge ₹150. The API does not send them.
 */
export function PricingCompliancePanel({ cinemaId }: { cinemaId: string }) {
  const q = useQuery({
    queryKey: ['cinema-pricing-compliance', cinemaId],
    queryFn: () => api.cinemas.pricingCompliance(cinemaId),
  });

  if (q.isLoading) {
    return (
      <Card title="Regulatory pricing">
        <Skeleton className="h-32 w-full" />
      </Card>
    );
  }
  if (q.isError || !q.data) return null;

  const c = q.data;
  const blocked = c.blocksPublishing;
  const review = c.status === 'REQUIRES_APPROVAL';

  return (
    <Card title="Regulatory pricing">
      {/*
        The verdict first and in words, because it is the only line most people will read.
        A status enum in a chip is not a sentence somebody can act on.
      */}
      <p
        role="status"
        className={`rounded-md px-3 py-2 text-[0.9375rem] ${
          blocked
            ? 'bg-status-error/10 text-status-error'
            : review
              ? 'bg-status-warning/10 text-status-warning'
              : 'bg-status-success/10 text-status-success'
        }`}
      >
        {c.summary}
      </p>

      <dl className="mt-4 grid gap-x-6 gap-y-3 text-[0.9375rem] sm:grid-cols-2">
        <Row
          label="Jurisdiction"
          value={[c.jurisdiction.city, c.jurisdiction.region, c.jurisdiction.country]
            .filter(Boolean)
            .join(', ')}
          hint={c.jurisdiction.localBodyType?.replace(/_/g, ' ').toLowerCase()}
        />
        <Row
          label="Classification"
          value={
            [c.classification.cinemaFormat, c.classification.climateType]
              .filter(Boolean)
              .map((v) => v!.replace(/_/g, ' ').toLowerCase())
              .join(', ') || 'Not classified'
          }
          // Named as the fix rather than the fault: an unclassified cinema is something the
          // organizer can correct in a minute, if they are told which field.
          hint={
            c.classification.cinemaFormat && c.classification.climateType
              ? undefined
              : 'Set the format and climate type so the correct rate applies.'
          }
        />
        <Row label="Order" value={c.regulatoryReference ?? 'None applies'} />
        <Row
          label="Maximum permitted price"
          value={
            c.maxTicketPriceMinor != null
              ? money(c.maxTicketPriceMinor, 'INR')
              : 'Not recorded for this classification'
          }
        />
        {c.maintenance && (
          <Row
            label="Maintenance charge"
            value={`${money(c.maintenance.perTicketMinor, 'INR')} per ticket`}
            hint={c.maintenance.description}
          />
        )}
        <Row label="Online booking fee" value={c.onlineFee.description} />
      </dl>

      {c.prices.length > 0 && (
        <div className="mt-5">
          <h3 className="text-caption font-semibold uppercase tracking-wide text-text-secondary">
            Your ticket prices
          </h3>
          <ul className="mt-2 space-y-1">
            {c.prices.map((p) => (
              <li
                key={p.ticketTypeId}
                className={`flex items-baseline justify-between gap-4 text-[0.9375rem] ${
                  p.ok ? 'text-text-secondary' : 'text-status-error'
                }`}
              >
                <span>
                  {p.name}
                  {/* The reason, inline, next to the price it refers to — not in a banner
                      the organizer has to hold in their head while scrolling. */}
                  {!p.ok && p.reason && <span className="ml-2 text-caption">{p.reason}</span>}
                </span>
                <span className="tabular-nums">{money(p.priceMinor, 'INR')}</span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </Card>
  );
}

function Row({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div>
      <dt className="text-caption uppercase tracking-wide text-text-muted">{label}</dt>
      <dd className="text-text-primary">{value}</dd>
      {hint && <p className="text-caption text-text-muted">{hint}</p>}
    </div>
  );
}
