'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import {
  api,
  Button,
  Card,
  Dialog,
  Input,
  PageHeader,
  Select,
  DataTable,
  useToast,
  errorMessage,
  type Column,
  type TaxRule,
} from '@eticketsgo/web-kit';

/**
 * Tax rules, edited by an administrator.
 *
 * ── WHY THIS PAGE IS NOT THE FEE-RULES PAGE WITH DIFFERENT COLUMNS ─────────────────
 * A fee band can be corrected in place. A live tax rate cannot: bookings snapshot the tax
 * they were charged, so editing one destroys no money but does destroy the answer to "what
 * were we charging in March, and why". The API refuses it. This page has to make that
 * refusal legible BEFORE somebody types into a field that will reject them — hence a live
 * rule shows a rate that is read-only and a **Change rate** action beside it, rather than an
 * editable box and an error afterwards.
 */

/** Rates are basis points on the wire; nobody thinks in basis points. */
const asPercent = (bp: number) => (bp / 100).toFixed(bp % 100 === 0 ? 0 : 2);
const fromPercent = (value: string) => Math.round(Number(value) * 100);

/** Draft state, kept as strings so a half-typed value does not fight the input. */
interface Draft {
  label: string;
  ratePercent: string;
  appliesTo: TaxRule['appliesTo'];
  taxGroup: string;
  country: string;
  currency: string;
  category: string;
  minUnit: string;
  maxUnit: string;
  inclusive: boolean;
  split: TaxRule['split'];
  priority: string;
  effectiveFrom: string;
}

const BLANK: Draft = {
  label: 'GST',
  ratePercent: '18',
  appliesTo: 'TICKETS',
  taxGroup: 'ADMISSION',
  country: 'India',
  currency: 'INR',
  category: '*',
  minUnit: '',
  maxUnit: '',
  inclusive: true,
  split: 'CGST_SGST',
  priority: '100',
  effectiveFrom: '',
};

const toDraft = (r: TaxRule): Draft => ({
  label: r.label,
  ratePercent: asPercent(r.rateBasisPoints),
  appliesTo: r.appliesTo,
  taxGroup: r.taxGroup,
  country: r.country,
  currency: r.currency,
  category: r.category,
  minUnit: r.minUnitMinor === null ? '' : String(r.minUnitMinor / 100),
  maxUnit: r.maxUnitMinor === null ? '' : String(r.maxUnitMinor / 100),
  inclusive: r.inclusive,
  split: r.split,
  priority: String(r.priority),
  effectiveFrom: r.effectiveFrom ? r.effectiveFrom.slice(0, 10) : '',
});

/** Minor units from a major-unit field. Empty means "unbounded", which is not zero. */
const toMinor = (value: string): number | null =>
  value.trim() === '' ? null : Math.round(Number(value) * 100);

export default function AdminTaxRules() {
  const qc = useQueryClient();
  const toast = useToast();
  const [editing, setEditing] = useState<TaxRule | null>(null);
  const [creating, setCreating] = useState(false);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [superseding, setSuperseding] = useState<TaxRule | null>(null);
  const [newRate, setNewRate] = useState('');
  const [changeFrom, setChangeFrom] = useState('');

  const { data, isLoading } = useQuery({
    queryKey: ['admin', 'tax-rules'],
    queryFn: () => api.admin.taxRules(),
  });

  const done = (message: string) => {
    toast.push(message, 'success');
    void qc.invalidateQueries({ queryKey: ['admin', 'tax-rules'] });
    setEditing(null);
    setCreating(false);
    setDraft(null);
    setSuperseding(null);
  };
  const failed = (e: unknown) => toast.push(errorMessage(e), 'error');

  const save = useMutation({
    mutationFn: (input: { id?: string; body: Partial<TaxRule> }) =>
      input.id
        ? api.admin.updateTaxRule(input.id, input.body)
        : api.admin.createTaxRule(input.body),
    onSuccess: () => done('Tax rule saved.'),
    onError: failed,
  });

  const toggle = useMutation({
    mutationFn: (rule: TaxRule) => api.admin.updateTaxRule(rule.id, { active: !rule.active }),
    onSuccess: () => done('Tax rule updated.'),
    onError: failed,
  });

  const supersede = useMutation({
    mutationFn: (input: { id: string; rateBasisPoints: number; effectiveFrom: string }) =>
      api.admin.supersedeTaxRule(input.id, {
        rateBasisPoints: input.rateBasisPoints,
        effectiveFrom: new Date(input.effectiveFrom).toISOString(),
      }),
    onSuccess: () => done('Rate change scheduled. Both rules are on file.'),
    onError: failed,
  });

  const remove = useMutation({
    mutationFn: (id: string) => api.admin.deleteTaxRule(id),
    onSuccess: () => done('Tax rule deleted.'),
    onError: failed,
  });

  const submit = () => {
    if (!draft) return;
    const body: Partial<TaxRule> = {
      label: draft.label,
      rateBasisPoints: fromPercent(draft.ratePercent),
      appliesTo: draft.appliesTo,
      taxGroup: draft.taxGroup,
      country: draft.country,
      currency: draft.currency,
      category: draft.category,
      minUnitMinor: toMinor(draft.minUnit),
      maxUnitMinor: toMinor(draft.maxUnit),
      inclusive: draft.inclusive,
      split: draft.split,
      priority: Number(draft.priority),
      effectiveFrom: draft.effectiveFrom ? new Date(draft.effectiveFrom).toISOString() : null,
    };
    /*
      A LIVE rule only ever sends the fields it is allowed to change. Sending the rate
      unchanged would still trip the API's guard on some future edit where the two drifted,
      and the point of this page is that the refusal never surprises anybody.
    */
    if (editing?.active) {
      save.mutate({
        id: editing.id,
        body: { label: body.label, priority: body.priority, taxGroup: body.taxGroup },
      });
      return;
    }
    save.mutate({ id: editing?.id, body });
  };

  const columns: Column<TaxRule>[] = [
    {
      key: 'status',
      header: 'Status',
      render: (r) => (
        <span
          className={
            r.inForceNow
              ? 'font-medium text-status-success'
              : r.active
                ? 'text-status-warning'
                : 'text-text-muted'
          }
        >
          {/*
            Three states, not two. A rule can be switched on and not yet started, or switched
            on and already superseded — "Active" would be true and misleading in both.
          */}
          {r.inForceNow ? 'Charging now' : r.active ? 'On, not in force' : 'Off'}
        </span>
      ),
    },
    { key: 'label', header: 'Label', render: (r) => r.label },
    {
      key: 'rate',
      header: 'Rate',
      render: (r) => <span className="tabular-nums">{asPercent(r.rateBasisPoints)}%</span>,
    },
    {
      key: 'applies',
      header: 'On',
      render: (r) => (r.appliesTo === 'FEES' ? 'Booking fee' : 'Tickets'),
    },
    {
      key: 'scope',
      header: 'Scope',
      render: (r) => (
        <span className="text-xs text-text-secondary">
          {r.country === '*' ? 'Any country' : r.country}
          {r.category !== '*' && ` · ${r.category}`}
          {(r.minUnitMinor !== null || r.maxUnitMinor !== null) && (
            <>
              {' · '}
              {r.minUnitMinor !== null && r.maxUnitMinor === null && `over ${r.minUnitMinor / 100}`}
              {r.maxUnitMinor !== null &&
                r.minUnitMinor === null &&
                `up to ${r.maxUnitMinor / 100}`}
              {r.minUnitMinor !== null &&
                r.maxUnitMinor !== null &&
                `${r.minUnitMinor / 100}–${r.maxUnitMinor / 100}`}
              {' per ticket'}
            </>
          )}
        </span>
      ),
    },
    {
      key: 'shape',
      header: 'How',
      render: (r) => (
        <span className="text-xs text-text-secondary">
          {r.inclusive ? 'In the price' : 'Added on top'}
          {r.split === 'CGST_SGST' && ' · CGST/SGST'}
        </span>
      ),
    },
    {
      key: 'dates',
      header: 'In force',
      render: (r) => (
        <span className="text-xs text-text-muted">
          {r.effectiveFrom ? r.effectiveFrom.slice(0, 10) : 'always'}
          {r.effectiveTo ? ` → ${r.effectiveTo.slice(0, 10)}` : ''}
        </span>
      ),
    },
    {
      key: 'actions',
      header: '',
      render: (r) => (
        <div className="flex flex-wrap justify-end gap-2">
          <Button
            size="sm"
            variant="secondary"
            onClick={() => {
              setEditing(r);
              setDraft(toDraft(r));
            }}
          >
            Edit
          </Button>
          {r.active && (
            <Button
              size="sm"
              variant="secondary"
              onClick={() => {
                setSuperseding(r);
                setNewRate(asPercent(r.rateBasisPoints));
                setChangeFrom('');
              }}
            >
              Change rate
            </Button>
          )}
          <Button size="sm" variant="secondary" onClick={() => toggle.mutate(r)}>
            {r.active ? 'Switch off' : 'Switch on'}
          </Button>
          {!r.active && (
            <Button size="sm" variant="danger" onClick={() => remove.mutate(r.id)}>
              Delete
            </Button>
          )}
        </div>
      ),
    },
  ];

  const charging = (data ?? []).filter((r) => r.inForceNow).length;

  return (
    <div className="space-y-6">
      <PageHeader
        title="Tax rules"
        description="Rates the platform charges. Every change is recorded in the audit log."
        action={
          <Button
            onClick={() => {
              setCreating(true);
              setDraft(BLANK);
            }}
          >
            Add rule
          </Button>
        }
      />

      {/*
        The headline answer first. "How many rules exist" is not the question anybody opens
        this page with; "are we charging tax right now" is.
      */}
      <Card>
        <p className="text-sm">
          {charging === 0 ? (
            <>
              <strong>No tax is being charged.</strong> Rules can exist and sit switched off —
              nothing reaches a customer until one is in force.
            </>
          ) : (
            <>
              <strong className="text-status-success">
                {charging} rule{charging === 1 ? '' : 's'} charging now.
              </strong>{' '}
              Every booking matching one is taxed.
            </>
          )}
        </p>
      </Card>

      <Card title="Rules">
        {isLoading ? (
          <p className="text-sm text-text-muted">Loading…</p>
        ) : (data ?? []).length === 0 ? (
          <p className="text-sm text-text-secondary">
            No tax rules configured, so no tax is computed or collected.
          </p>
        ) : (
          <DataTable columns={columns} rows={data ?? []} rowKey={(r) => r.id} />
        )}
      </Card>

      <Card title="How these resolve">
        <ul className="list-disc space-y-1 pl-5 text-xs text-text-muted">
          <li>
            Rates are entered as a <strong>percentage</strong> and stored as basis points, so 18
            means 18%.
          </li>
          <li>
            Bands apply to the price of <strong>one ticket</strong>, not the order total — ten ₹90
            tickets are ten ₹90 tickets, not one ₹900 order.
          </li>
          <li>
            Rules sharing a <strong>group</strong> are alternatives: the lowest priority number wins
            and the rest are skipped. Leave the group empty for a rule that always applies alongside
            the others, which is what a second tax layer needs.
          </li>
          <li>
            <strong>In the price</strong> means the ticket already contains the tax (India);{' '}
            <strong>added on top</strong> means the customer pays it in addition.
          </li>
          <li>
            A <strong>live</strong> rule&rsquo;s rate cannot be edited — use{' '}
            <strong>Change rate</strong>, which closes it at a date and opens its successor. Both
            stay on file, so what was charged last quarter is still answerable.
          </li>
        </ul>
      </Card>

      <Dialog
        open={creating || !!editing}
        onClose={() => {
          setCreating(false);
          setEditing(null);
          setDraft(null);
        }}
        title={creating ? 'Add tax rule' : `Edit — ${editing?.label ?? ''}`}
      >
        {draft && (
          <div className="space-y-3">
            {editing?.active && (
              <p className="rounded-md bg-background-subtle p-2 text-xs text-text-secondary">
                This rule is charging customers. Its rate, basis and band are shown but cannot be
                changed here — that would erase what was being charged before. Use{' '}
                <strong>Change rate</strong> instead.
              </p>
            )}
            <Input
              label="Label (shown on the receipt)"
              value={draft.label}
              onChange={(e) => setDraft({ ...draft, label: e.target.value })}
            />
            <Input
              label="Rate (%)"
              inputMode="decimal"
              disabled={editing?.active}
              value={draft.ratePercent}
              onChange={(e) => setDraft({ ...draft, ratePercent: e.target.value })}
            />
            <Select
              label="Charged on"
              disabled={editing?.active}
              value={draft.appliesTo}
              onChange={(e) =>
                setDraft({ ...draft, appliesTo: e.target.value as TaxRule['appliesTo'] })
              }
            >
              <option value="TICKETS">Tickets</option>
              <option value="FEES">Booking fee</option>
              <option value="TICKETS_AND_FEES">Tickets and booking fee</option>
            </Select>
            <Input
              label="Group (alternatives — leave empty to always apply)"
              value={draft.taxGroup}
              onChange={(e) => setDraft({ ...draft, taxGroup: e.target.value })}
            />
            <div className="grid grid-cols-2 gap-3">
              <Input
                label="Country ('*' for any)"
                value={draft.country}
                onChange={(e) => setDraft({ ...draft, country: e.target.value })}
              />
              <Input
                label="Currency ('*' for any)"
                value={draft.currency}
                onChange={(e) => setDraft({ ...draft, currency: e.target.value })}
              />
            </div>
            <Input
              label="Category ('*' for any; MOVIE for cinema)"
              value={draft.category}
              onChange={(e) => setDraft({ ...draft, category: e.target.value })}
            />
            <div className="grid grid-cols-2 gap-3">
              <Input
                label="From, per ticket (blank = no lower bound)"
                inputMode="decimal"
                disabled={editing?.active}
                value={draft.minUnit}
                onChange={(e) => setDraft({ ...draft, minUnit: e.target.value })}
              />
              <Input
                label="To, per ticket (blank = and above)"
                inputMode="decimal"
                disabled={editing?.active}
                value={draft.maxUnit}
                onChange={(e) => setDraft({ ...draft, maxUnit: e.target.value })}
              />
            </div>
            <Select
              label="Tax sits"
              disabled={editing?.active}
              value={draft.inclusive ? 'in' : 'on'}
              onChange={(e) => setDraft({ ...draft, inclusive: e.target.value === 'in' })}
            >
              <option value="in">In the price (India)</option>
              <option value="on">Added on top</option>
            </Select>
            <Select
              label="Presentation"
              disabled={editing?.active}
              value={draft.split}
              onChange={(e) => setDraft({ ...draft, split: e.target.value as TaxRule['split'] })}
            >
              <option value="NONE">One line</option>
              <option value="CGST_SGST">CGST + SGST, or IGST across a state border</option>
            </Select>
            <div className="grid grid-cols-2 gap-3">
              <Input
                label="Priority (lower wins within a group)"
                inputMode="numeric"
                value={draft.priority}
                onChange={(e) => setDraft({ ...draft, priority: e.target.value })}
              />
              <Input
                label="In force from"
                type="date"
                value={draft.effectiveFrom}
                onChange={(e) => setDraft({ ...draft, effectiveFrom: e.target.value })}
              />
            </div>
            <p className="text-xs text-text-muted">
              A new rule is created <strong>switched off</strong>. Switch it on from the list when
              you mean to start charging.
            </p>
            <Button className="w-full" loading={save.isPending} onClick={submit}>
              Save
            </Button>
          </div>
        )}
      </Dialog>

      <Dialog
        open={!!superseding}
        onClose={() => setSuperseding(null)}
        title={`Change rate — ${superseding?.label ?? ''}`}
      >
        {superseding && (
          <div className="space-y-3">
            <p className="text-sm text-text-secondary">
              The current rule stops at this date and a new one takes over at the new rate. Both
              stay on file, so bookings taxed under the old rate remain explainable.
            </p>
            <Input
              label="New rate (%)"
              inputMode="decimal"
              value={newRate}
              onChange={(e) => setNewRate(e.target.value)}
            />
            <Input
              label="From"
              type="date"
              value={changeFrom}
              onChange={(e) => setChangeFrom(e.target.value)}
            />
            <p className="text-xs text-text-muted">
              Currently {asPercent(superseding.rateBasisPoints)}%. The changeover is exact — at that
              instant one rule applies, never both and never neither.
            </p>
            <Button
              className="w-full"
              loading={supersede.isPending}
              disabled={!changeFrom || newRate.trim() === ''}
              onClick={() =>
                supersede.mutate({
                  id: superseding.id,
                  rateBasisPoints: fromPercent(newRate),
                  effectiveFrom: changeFrom,
                })
              }
            >
              Schedule the change
            </Button>
          </div>
        )}
      </Dialog>
    </div>
  );
}
