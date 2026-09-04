'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import {
  api,
  Button,
  Card,
  DataTable,
  Input,
  Select,
  PageHeader,
  ErrorState,
  useToast,
  errorMessage,
  money,
  dateOnly,
  type Column,
  type CinemaPricingPolicyRow,
} from '@eticketsgo/web-kit';

/**
 * The cinema pricing rule table, as an administrator edits it.
 *
 * ── WHY THERE IS NO EDIT BUTTON ON AN ACTIVE ROW ───────────────────────────────────
 * Editing an ACTIVE policy would rewrite the financial interpretation of every order sold
 * under it. Bookings carry their own snapshot so totals stay safe, but the audit trail would
 * then disagree with invoices already in customers' hands, which is a worse problem than the
 * one in-place editing solves. ACTIVE rows offer Supersede and Disable; DRAFT rows offer
 * Edit and Activate. The server refuses the rest regardless — this only stops an admin being
 * offered a button that will fail.
 *
 * ── WHY THE NUMBERS ARE NOT VALIDATED HERE ─────────────────────────────────────────
 * They are law, and this screen has no opinion about law. What it does have is the shape:
 * a CAPPED policy needs a cap, an amount needs a treatment. Those the server and the database
 * both refuse, and the errors they return are shown verbatim because they are written for
 * the person reading this page.
 */
const STATUS_TONE: Record<string, string> = {
  ACTIVE: 'bg-status-success/10 text-status-success',
  DRAFT: 'bg-status-warning/10 text-status-warning',
  SUPERSEDED: 'bg-background-subtle text-text-muted',
  DISABLED: 'bg-status-error/10 text-status-error',
};

const scopeOf = (p: CinemaPricingPolicyRow) =>
  [
    p.region !== '*' ? p.region : p.country,
    p.district !== '*' ? p.district : null,
    p.city !== '*' ? p.city : null,
    p.localBodyType?.replace(/_/g, ' ').toLowerCase(),
    p.cinemaFormat?.replace(/_/g, ' ').toLowerCase(),
    p.climateType?.replace(/_/g, '-').toLowerCase(),
    p.seatCategory?.replace(/_/g, '-').toLowerCase(),
  ]
    .filter(Boolean)
    .join(' · ');

export default function CinemaPricingPolicies() {
  const qc = useQueryClient();
  const toast = useToast();
  const [inspect, setInspect] = useState({
    country: 'India',
    region: 'Andhra Pradesh',
    city: 'Vijayawada',
    localBodyType: 'MUNICIPAL_CORPORATION',
    cinemaFormat: 'MULTIPLEX',
    climateType: 'AC',
    seatCategory: 'REGULAR',
  });

  const q = useQuery({
    queryKey: ['cinema-pricing-policies'],
    queryFn: () => api.admin.cinemaPricingPolicies(),
  });

  const inspectQ = useQuery({
    queryKey: ['cinema-pricing-inspect', inspect],
    queryFn: () => api.admin.inspectCinemaPricing(inspect),
  });

  const act = useMutation({
    mutationFn: ({ id, what }: { id: string; what: 'activate' | 'disable' }) =>
      what === 'activate'
        ? api.admin.activateCinemaPricingPolicy(id)
        : api.admin.disableCinemaPricingPolicy(id),
    onSuccess: async (_r, v) => {
      toast.push(v.what === 'activate' ? 'Policy activated.' : 'Policy disabled.');
      await qc.invalidateQueries({ queryKey: ['cinema-pricing-policies'] });
      await qc.invalidateQueries({ queryKey: ['cinema-pricing-inspect'] });
    },
    // Shown verbatim: the server's refusals name the order and say what to fix.
    onError: (e) => toast.push(errorMessage(e)),
  });

  const columns: Column<CinemaPricingPolicyRow>[] = [
    {
      key: 'scope',
      header: 'Scope',
      render: (p) => (
        <div>
          <div className="font-medium text-text-primary">{scopeOf(p)}</div>
          <div className="text-caption text-text-muted">{p.regulatoryReference}</div>
        </div>
      ),
    },
    {
      key: 'status',
      header: 'Status',
      render: (p) => (
        <span
          className={`rounded-md px-2 py-0.5 text-caption font-medium ${STATUS_TONE[p.status]}`}
        >
          {p.status} · v{p.version}
        </span>
      ),
    },
    {
      key: 'effective',
      header: 'Effective',
      render: (p) => (
        <span className="text-caption">
          {dateOnly(p.effectiveFrom)}
          {p.effectiveTo ? ` → ${dateOnly(p.effectiveTo)}` : ''}
        </span>
      ),
    },
    {
      key: 'maintenance',
      header: 'Maintenance',
      render: (p) =>
        p.maintenanceChargeMinor > 0 ? (
          <span
            className={p.maintenanceTreatment === 'UNCONFIRMED' ? 'text-status-warning' : undefined}
          >
            {money(p.maintenanceChargeMinor, p.currency === '*' ? 'INR' : p.currency)}{' '}
            {p.maintenanceTreatment === 'INCLUDED_IN_TICKET_PRICE'
              ? 'included'
              : p.maintenanceTreatment === 'ADDED_TO_TICKET_PRICE'
                ? 'added'
                : /* The state that exists so nobody has to invent one. */ 'treatment unconfirmed'}
          </span>
        ) : (
          <span className="text-text-muted">—</span>
        ),
    },
    {
      key: 'fee',
      header: 'Online fee',
      render: (p) => (
        <span className="text-caption">
          {p.onlineFeePolicy.replace(/_/g, ' ').toLowerCase()}
          {p.onlineFeeCapMinor != null ? ` · max ${money(p.onlineFeeCapMinor, 'INR')}` : ''}
        </span>
      ),
    },
    {
      key: 'ceiling',
      header: 'Max price',
      render: (p) =>
        p.ticketPriceMaxMinor != null ? (
          money(p.ticketPriceMaxMinor, 'INR')
        ) : (
          // Said in words, because a blank cell reads as "no limit" and this means
          // "no limit recorded" — which is a different and much more dangerous thing.
          <span className="text-text-muted">not recorded</span>
        ),
    },
    {
      key: 'updated',
      header: 'Last changed',
      render: (p) => <span className="text-caption text-text-muted">{dateOnly(p.updatedAt)}</span>,
    },
    {
      key: 'actions',
      header: '',
      render: (p) => (
        <div className="flex gap-2">
          {/* DRAFT rows can become live. Nothing else can be edited into being live. */}
          {p.status === 'DRAFT' && (
            <Button
              size="sm"
              loading={act.isPending}
              onClick={() => act.mutate({ id: p.id, what: 'activate' })}
            >
              Activate
            </Button>
          )}
          {p.status === 'ACTIVE' && (
            <Button
              size="sm"
              variant="secondary"
              loading={act.isPending}
              onClick={() => act.mutate({ id: p.id, what: 'disable' })}
            >
              Disable
            </Button>
          )}
        </div>
      ),
    },
  ];

  if (q.isError)
    return <ErrorState message={errorMessage(q.error)} onRetry={() => void q.refetch()} />;

  return (
    <div className="space-y-6">
      <PageHeader
        title="Cinema pricing policies"
        description="Government orders as configuration. History is superseded, never edited."
      />

      <Card title="What applies right now">
        <p className="mb-3 text-caption text-text-secondary">
          Answers the question an organizer asks as “why can’t I publish?”. It reads the same
          resolver the checkout uses, so it cannot disagree with what a customer would be charged.
        </p>
        <div className="grid gap-3 sm:grid-cols-3 lg:grid-cols-4">
          <Input
            label="State"
            value={inspect.region}
            onChange={(e) => setInspect({ ...inspect, region: e.target.value })}
          />
          <Input
            label="City"
            value={inspect.city}
            onChange={(e) => setInspect({ ...inspect, city: e.target.value })}
          />
          <Select
            label="Local body"
            value={inspect.localBodyType}
            onChange={(e) => setInspect({ ...inspect, localBodyType: e.target.value })}
          >
            {[
              'MUNICIPAL_CORPORATION',
              'MUNICIPALITY',
              'NAGAR_PANCHAYAT',
              'GRAM_PANCHAYAT',
              'OTHER',
            ].map((v) => (
              <option key={v} value={v}>
                {v.replace(/_/g, ' ')}
              </option>
            ))}
          </Select>
          <Select
            label="Format"
            value={inspect.cinemaFormat}
            onChange={(e) => setInspect({ ...inspect, cinemaFormat: e.target.value })}
          >
            {['MULTIPLEX', 'SINGLE_SCREEN', 'SPECIAL_THEATRE'].map((v) => (
              <option key={v} value={v}>
                {v.replace(/_/g, ' ')}
              </option>
            ))}
          </Select>
          <Select
            label="Climate"
            value={inspect.climateType}
            onChange={(e) => setInspect({ ...inspect, climateType: e.target.value })}
          >
            {['AC', 'AIR_COOLED', 'NON_AC'].map((v) => (
              <option key={v} value={v}>
                {v}
              </option>
            ))}
          </Select>
          <Input
            label="Seat class"
            value={inspect.seatCategory}
            onChange={(e) => setInspect({ ...inspect, seatCategory: e.target.value })}
          />
        </div>

        {inspectQ.data && (
          <div className="mt-4 rounded-md border border-border bg-background-subtle p-3">
            <p className="font-medium text-text-primary">{inspectQ.data.status}</p>
            <p className="mt-1 text-caption text-text-secondary">{inspectQ.data.explanation}</p>
            {inspectQ.data.policy?.ticketPriceMaxMinor != null && (
              <p className="mt-2 text-caption text-text-secondary">
                Maximum permitted ticket price:{' '}
                <strong>{money(inspectQ.data.policy.ticketPriceMaxMinor, 'INR')}</strong>
              </p>
            )}
          </div>
        )}
      </Card>

      <Card title="All policies">
        <DataTable columns={columns} rows={q.data} loading={q.isLoading} rowKey={(p) => p.id} />
        <p className="mt-3 text-caption text-text-muted">
          An ACTIVE policy cannot be edited. Replace it with a new version instead, so what was
          already sold under it stays readable.
        </p>
      </Card>
    </div>
  );
}
