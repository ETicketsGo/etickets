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
  Dialog,
  PageHeader,
  ErrorState,
  useToast,
  errorMessage,
  money,
  dateOnly,
  type Column,
  type CinemaPricingPolicyRow,
  MARKETS,
  marketFor,
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

const LOCAL_BODIES = [
  'MUNICIPAL_CORPORATION',
  'MUNICIPALITY',
  'NAGAR_PANCHAYAT',
  'GRAM_PANCHAYAT',
  'OTHER',
] as const;
const FORMATS = ['MULTIPLEX', 'SINGLE_SCREEN', 'SPECIAL_THEATRE'] as const;
const CLIMATES = ['AC', 'AIR_COOLED', 'NON_AC'] as const;
const TREATMENTS = [
  'NOT_APPLICABLE',
  'INCLUDED_IN_TICKET_PRICE',
  'ADDED_TO_TICKET_PRICE',
  'UNCONFIRMED',
] as const;
const FEE_POLICIES = [
  'ALLOWED',
  'CAPPED',
  'INCLUDED_IN_TICKET_PRICE',
  'PROHIBITED',
  'REQUIRES_APPROVAL',
] as const;

/**
 * Write down a rate order.
 *
 * ── WHY THIS SCREEN COULD NOT CREATE ONE ───────────────────────────────
 * It could activate and disable policies and had no way to add one, so every policy on the
 * platform came from a seed script and a regulator issuing a new order meant a deployment.
 * The endpoint existed the whole time; only the form was missing.
 *
 * ── WHY IT MAKES A DRAFT ──────────────────────────────────────────
 * An ACTIVE policy decides what a cinema may charge and how a maintenance charge is treated
 * on an invoice. The service refuses to edit one, because editing would rewrite the financial
 * interpretation of orders already sold under it — so writing a policy and putting it into
 * force are two separate acts, with the resolver above available in between to check it.
 *
 * ── WHAT IS DELIBERATELY NOT PREFILLED ──────────────────────────────
 * No rates, no caps, no defaults that look like law. Every number here comes off a government
 * order, and the reference to that order is required — a policy nobody can trace to a
 * document is a number somebody invented.
 */
function NewPolicyDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const [form, setForm] = useState({
    country: 'India',
    region: '',
    district: '',
    city: '',
    localBodyType: 'MUNICIPAL_CORPORATION',
    cinemaFormat: 'MULTIPLEX',
    climateType: 'AC',
    seatCategory: '',
    maintenanceChargeMinor: '',
    maintenanceTreatment: 'UNCONFIRMED',
    onlineFeePolicy: 'REQUIRES_APPROVAL',
    onlineFeeCapMinor: '',
    ticketPriceMaxMinor: '',
    effectiveFrom: '',
    regulatoryReference: '',
    regulatoryDocumentUrl: '',
  });
  const market = marketFor(form.country);
  const currency = market?.currency ?? 'INR';
  const set = (patch: Partial<typeof form>) => setForm((f) => ({ ...f, ...patch }));

  const create = useMutation({
    mutationFn: () =>
      api.admin.createCinemaPricingPolicy({
        country: form.country,
        region: form.region,
        district: form.district,
        city: form.city,
        // Follows the country, like every other price on this platform.
        currency,
        localBodyType: form.localBodyType,
        cinemaFormat: form.cinemaFormat,
        climateType: form.climateType,
        seatCategory: form.seatCategory.trim() || null,
        maintenanceChargeMinor: Number(form.maintenanceChargeMinor || 0),
        maintenanceTreatment: form.maintenanceTreatment,
        onlineFeePolicy: form.onlineFeePolicy,
        onlineFeeCapMinor:
          form.onlineFeePolicy === 'CAPPED' ? Number(form.onlineFeeCapMinor || 0) : null,
        ticketPriceMaxMinor: form.ticketPriceMaxMinor ? Number(form.ticketPriceMaxMinor) : null,
        effectiveFrom: form.effectiveFrom,
        regulatoryReference: form.regulatoryReference.trim(),
        regulatoryDocumentUrl: form.regulatoryDocumentUrl.trim() || null,
      }),
    onSuccess: async () => {
      toast.push('Draft policy created. Review it, then activate.');
      await qc.invalidateQueries({ queryKey: ['cinema-pricing-policies'] });
      onClose();
    },
    onError: (e) => toast.push(errorMessage(e), 'error'),
  });

  /* The scope and the paper trail. Without either it cannot be resolved or defended. */
  const invalid = !form.region.trim() || !form.effectiveFrom || !form.regulatoryReference.trim();

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="New pricing policy (draft)"
      footer={
        <div className="flex justify-end gap-2">
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={() => create.mutate()} disabled={invalid} loading={create.isPending}>
            Create draft
          </Button>
        </div>
      }
    >
      <div className="space-y-3">
        <p className="text-caption text-text-secondary">
          Creates a DRAFT. Nothing changes what a customer is charged until it is activated, and an
          active policy can only be replaced — never edited.
        </p>

        <div className="grid gap-3 sm:grid-cols-2">
          <Select
            label="Country"
            value={form.country}
            onChange={(e) => set({ country: e.target.value, region: '' })}
          >
            {MARKETS.map((m) => (
              <option key={m.code} value={m.name}>
                {m.name}
              </option>
            ))}
          </Select>
          <Select
            label={market?.regionLabel ?? 'State'}
            value={form.region}
            onChange={(e) => set({ region: e.target.value })}
          >
            <option value="">Select…</option>
            {(market?.regions ?? []).map((r) => (
              <option key={r.name} value={r.name}>
                {r.name}
              </option>
            ))}
          </Select>
          <Input
            label="District"
            hint="Blank applies it to the whole state."
            value={form.district}
            onChange={(e) => set({ district: e.target.value })}
          />
          <Input
            label="City"
            hint="Blank applies it to the whole district."
            value={form.city}
            onChange={(e) => set({ city: e.target.value })}
          />
          <Select
            label="Local body"
            value={form.localBodyType}
            onChange={(e) => set({ localBodyType: e.target.value })}
          >
            {LOCAL_BODIES.map((v) => (
              <option key={v} value={v}>
                {v.replace(/_/g, ' ')}
              </option>
            ))}
          </Select>
          <Select
            label="Format"
            value={form.cinemaFormat}
            onChange={(e) => set({ cinemaFormat: e.target.value })}
          >
            {FORMATS.map((v) => (
              <option key={v} value={v}>
                {v.replace(/_/g, ' ')}
              </option>
            ))}
          </Select>
          <Select
            label="Climate"
            value={form.climateType}
            onChange={(e) => set({ climateType: e.target.value })}
          >
            {CLIMATES.map((v) => (
              <option key={v} value={v}>
                {v.replace(/_/g, ' ')}
              </option>
            ))}
          </Select>
          <Input
            label="Seat class"
            placeholder="e.g. REGULAR"
            hint="Blank applies it to every class."
            value={form.seatCategory}
            onChange={(e) => set({ seatCategory: e.target.value })}
          />
        </div>

        <div className="grid gap-3 sm:grid-cols-2">
          <Input
            label={`Maximum ticket price (minor units, ${currency})`}
            inputMode="numeric"
            hint="Blank if the order sets no ceiling."
            value={form.ticketPriceMaxMinor}
            onChange={(e) => set({ ticketPriceMaxMinor: e.target.value })}
          />
          <Input
            label={`Maintenance charge (minor units, ${currency})`}
            inputMode="numeric"
            value={form.maintenanceChargeMinor}
            onChange={(e) => set({ maintenanceChargeMinor: e.target.value })}
          />
          <Select
            label="Maintenance treatment"
            value={form.maintenanceTreatment}
            hint="Whether the charge sits inside the ticket price or is added to it."
            onChange={(e) => set({ maintenanceTreatment: e.target.value })}
          >
            {TREATMENTS.map((v) => (
              <option key={v} value={v}>
                {v.replace(/_/g, ' ')}
              </option>
            ))}
          </Select>
          <Select
            label="Online booking fee"
            value={form.onlineFeePolicy}
            onChange={(e) => set({ onlineFeePolicy: e.target.value })}
          >
            {FEE_POLICIES.map((v) => (
              <option key={v} value={v}>
                {v.replace(/_/g, ' ')}
              </option>
            ))}
          </Select>
          {form.onlineFeePolicy === 'CAPPED' && (
            <Input
              label={`Fee cap (minor units, ${currency})`}
              inputMode="numeric"
              hint="A cap of zero means no fee may be charged, which is not the same as no cap."
              value={form.onlineFeeCapMinor}
              onChange={(e) => set({ onlineFeeCapMinor: e.target.value })}
            />
          )}
          <Input
            label="Effective from"
            type="date"
            value={form.effectiveFrom}
            onChange={(e) => set({ effectiveFrom: e.target.value })}
          />
        </div>

        <Input
          label="Regulatory reference"
          placeholder="e.g. G.O.Ms.No.13, Home (General-A) Department, dated 07-03-2022"
          hint="Required. A policy nobody can trace to a document is a number somebody invented."
          value={form.regulatoryReference}
          onChange={(e) => set({ regulatoryReference: e.target.value })}
        />
        <Input
          label="Link to the order (optional)"
          value={form.regulatoryDocumentUrl}
          onChange={(e) => set({ regulatoryDocumentUrl: e.target.value })}
        />
      </div>
    </Dialog>
  );
}

export default function CinemaPricingPolicies() {
  const qc = useQueryClient();
  const toast = useToast();
  const [drafting, setDrafting] = useState(false);
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
        action={<Button onClick={() => setDrafting(true)}>New policy</Button>}
      />

      {/*
        ── THERE WAS NO WAY TO ADD ONE ───────────────────────────────────────────────
        The screen could activate and disable policies and could not create one, so every
        policy on the platform came from a seed script. A regulator issuing a new order meant
        a deployment.

        It creates a DRAFT, deliberately. An ACTIVE policy rewrites the financial
        interpretation of every order sold under it, which is why the service refuses to edit
        one — so a new policy is written, checked with the resolver above, and activated as a
        separate act.
      */}
      <NewPolicyDialog open={drafting} onClose={() => setDrafting(false)} />

      <Card title="What applies right now">
        <p className="mb-3 text-caption text-text-secondary">
          Answers the question an organizer asks as “why can’t I publish?”. It reads the same
          resolver the checkout uses, so it cannot disagree with what a customer would be charged.
        </p>
        {/*
          ── COUNTRY FIRST, AND BOTH PICKED ────────────────────────────────────────────
          This screen opened on India with a typed "State" box and no country at all, which
          reads as "this feature is for India". It is not: the model is country/region/city,
          and a rate order is a thing several jurisdictions issue. Nothing here was
          India-specific except the form.

          Typed, the region also had to match a venue's spelling exactly for the resolver to
          find anything — and a mismatch answers "no policy applies", which is
          indistinguishable from "no policy exists".
        */}
        <div className="grid gap-3 sm:grid-cols-3 lg:grid-cols-4">
          <Select
            label="Country"
            value={inspect.country}
            onChange={(e) =>
              setInspect({ ...inspect, country: e.target.value, region: '', city: '' })
            }
          >
            {MARKETS.map((m) => (
              <option key={m.code} value={m.name}>
                {m.name}
              </option>
            ))}
          </Select>
          <Select
            label={marketFor(inspect.country)?.regionLabel ?? 'State'}
            value={inspect.region}
            onChange={(e) => setInspect({ ...inspect, region: e.target.value })}
          >
            <option value="">Whole country</option>
            {(marketFor(inspect.country)?.regions ?? []).map((r) => (
              <option key={r.name} value={r.name}>
                {r.name}
              </option>
            ))}
          </Select>
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
