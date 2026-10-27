'use client';

import { useParams } from 'next/navigation';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState, type ReactNode } from 'react';
import {
  ALL_ENTITLEMENT_KEYS,
  ENTITLEMENT_DEFINITIONS,
  type ResolvedEntitlement,
} from '@eticketsgo/shared-types';
import {
  api,
  Badge,
  Button,
  ButtonLink,
  Card,
  DataTable,
  Dialog,
  EmptyState,
  ErrorState,
  Input,
  PageHeader,
  Select,
  Skeleton,
  errorMessage,
  money,
  recordedAt,
  useToast,
  type AdminAdjustmentRow,
  type AdminBillingAccountDetail,
  type AdminLedgerRow,
  type AdminOverrideRow,
  type AdminSubscriptionDetail,
  type Column,
} from '@eticketsgo/web-kit';
import { useHolds } from '@/lib/capabilities';
import { ReasonField, SubscriptionStatusBadge, day } from '@/components/billing/billing-ui';
import {
  ADJUSTMENT_KIND_WORDS,
  BILLING_COPY,
  ENTITLEMENT_SOURCE_WORDS,
  LEDGER_REASON_WORDS,
  bpsText,
  endOfDayIso,
  entitlementKind,
  entitlementLabel,
  entitlementValueText,
  majorToMinor,
  percentToBps,
  planWords,
  reasonProblem,
  startOfDayIso,
  subscriptionSourceWords,
  wholeNumber,
} from '@/lib/billing';

type Action = 'trial' | 'complimentary' | 'end' | 'credits' | 'discount' | 'override';

/**
 * One organization's billing: its plan, what it can use, its credits and its history.
 *
 * Every action asks for a reason, which goes into the audit log, and is shown only to the
 * holder of the duty the API checks for it: BILLING_ADJUST for trials, free plans, credits and
 * discounts; ENTITLEMENT_GRANT for a single feature.
 */
export default function BillingAccountPage() {
  const { organizationId } = useParams<{ organizationId: string }>();
  const orgId = organizationId;
  const mayAdjust = useHolds('BILLING_ADJUST');
  const mayGrant = useHolds('ENTITLEMENT_GRANT');
  const qc = useQueryClient();
  const [action, setAction] = useState<Action | null>(null);
  const [revoking, setRevoking] = useState<AdminOverrideRow | null>(null);

  const detail = useQuery({
    queryKey: ['admin', 'billing', 'account', orgId],
    queryFn: () => api.admin.billing.account(orgId),
  });
  const done = () => {
    setAction(null);
    setRevoking(null);
    qc.invalidateQueries({ queryKey: ['admin', 'billing'] });
  };

  if (detail.isError) {
    return (
      <div className="space-y-6">
        <PageHeader title="Organization billing" />
        <ErrorState message={errorMessage(detail.error)} onRetry={() => detail.refetch()} />
        <ButtonLink href="/admin/billing/subscriptions" variant="outline">
          Back to subscriptions
        </ButtonLink>
      </div>
    );
  }
  const d = detail.data;
  if (!d) {
    return (
      <div className="space-y-4">
        <Skeleton className="h-12 w-1/2" />
        <Skeleton className="h-40" />
        <Skeleton className="h-40" />
      </div>
    );
  }

  const sub = d.currentSubscription;
  const canEnd = sub?.status === 'TRIALING' || sub?.status === 'COMPLIMENTARY';

  return (
    <div className="space-y-6">
      <PageHeader
        title={d.organization.name}
        description={`Organization ${d.organization.id}. Registered in ${d.organization.registeredCountry ?? 'an unknown country'}. Organizer status: ${d.organization.status.toLowerCase().replace(/_/g, ' ')}.`}
        action={
          <ButtonLink href="/admin/billing/subscriptions" variant="outline">
            All subscriptions
          </ButtonLink>
        }
      />

      {(mayAdjust || mayGrant) && (
        <Card title="Actions">
          <div className="flex flex-wrap gap-2">
            {mayAdjust && (
              <>
                <Button variant="outline" onClick={() => setAction('trial')}>
                  Give a trial
                </Button>
                <Button variant="outline" onClick={() => setAction('complimentary')}>
                  Give a free plan
                </Button>
                {canEnd && (
                  <Button variant="outline" onClick={() => setAction('end')}>
                    End trial or free plan
                  </Button>
                )}
                <Button variant="outline" onClick={() => setAction('credits')}>
                  Give email credits
                </Button>
                <Button variant="outline" onClick={() => setAction('discount')}>
                  Record a discount
                </Button>
              </>
            )}
            {mayGrant && (
              <Button variant="outline" onClick={() => setAction('override')}>
                Give a single feature
              </Button>
            )}
          </div>
          <p className="mt-3 text-caption text-text-muted">
            Each action asks for a reason. It is saved in the audit log.
          </p>
        </Card>
      )}

      <div className="grid gap-6 lg:grid-cols-2">
        <Card title="Billing account">
          {d.account ? (
            <Facts
              rows={[
                ['Country', d.account.country],
                ['Currency', d.account.currency],
                ['Payment provider', d.account.provider],
                ['Billing email', d.account.billingEmail ?? '-'],
                ['Tax id', d.account.taxId ?? '-'],
              ]}
            />
          ) : (
            <p className="text-sm text-text-secondary">
              No billing account yet. One is made the first time staff give this organization
              something, or when it starts a paid plan.
            </p>
          )}
        </Card>

        <Card title="Current plan">
          {sub ? (
            <Facts
              rows={[
                ['Plan', planWords(sub.plan.code)],
                ['State', <SubscriptionStatusBadge key="s" status={sub.status} />],
                ['How', subscriptionSourceWords(sub.source)],
                ['Price', sub.price ? money(sub.price.amountMinor, sub.price.currency) : 'None'],
                ['Period ends', day(sub.currentPeriodEnd)],
                ...(sub.trialEndsAt ? [['Trial ends', day(sub.trialEndsAt)] as Fact] : []),
                ...(sub.graceEndsAt ? [['Grace ends', day(sub.graceEndsAt)] as Fact] : []),
                ...(sub.cancelAtPeriodEnd ? [['Cancels', 'At the end of the period'] as Fact] : []),
                ...(sub.scheduledPlan
                  ? [['Changes to', planWords(sub.scheduledPlan.code)] as Fact]
                  : []),
              ]}
            />
          ) : (
            <p className="text-sm text-text-secondary">
              No subscription. This organization is on the Free plan.
            </p>
          )}
        </Card>
      </div>

      <Card title="What it can use">
        <EntitlementsTable rows={d.entitlements.entitlements} />
      </Card>

      <Card title="Email this month">
        <Facts
          rows={[
            ['Period', d.usage.periodKey],
            ['Included in the plan', d.usage.quota.toLocaleString('en-US')],
            ['Sent', d.usage.used.toLocaleString('en-US')],
            ['Extra credits', d.usage.credits.toLocaleString('en-US')],
            ['Left to send', d.usage.remaining.toLocaleString('en-US')],
          ]}
        />
      </Card>

      <Card title="Single feature grants">
        <OverridesTable rows={d.overrides} mayRevoke={mayGrant} onRevoke={(o) => setRevoking(o)} />
      </Card>

      <Card title="Credit and usage ledger">
        <LedgerTable rows={d.ledger.slice(0, 50)} />
        {d.ledger.length > 50 && (
          <p className="mt-2 text-caption text-text-muted">Showing the latest 50.</p>
        )}
      </Card>

      <Card title="Invoices">
        <InvoicesTable detail={d} />
      </Card>

      <Card title="Payments">
        <PaymentsTable detail={d} />
      </Card>

      <Card title="Discounts and adjustments">
        <AdjustmentsTable rows={d.adjustments} />
      </Card>

      <Card title="Plan history">
        <HistoryTable rows={d.subscriptions} />
      </Card>

      {action === 'trial' && (
        <TrialDialog orgId={orgId} onClose={() => setAction(null)} onDone={done} />
      )}
      {action === 'complimentary' && (
        <ComplimentaryDialog orgId={orgId} onClose={() => setAction(null)} onDone={done} />
      )}
      {action === 'end' && sub && (
        <EndGrantDialog orgId={orgId} sub={sub} onClose={() => setAction(null)} onDone={done} />
      )}
      {action === 'credits' && (
        <CreditsDialog orgId={orgId} onClose={() => setAction(null)} onDone={done} />
      )}
      {action === 'discount' && (
        <DiscountDialog
          orgId={orgId}
          currency={accountCurrency(d)}
          onClose={() => setAction(null)}
          onDone={done}
        />
      )}
      {action === 'override' && (
        <OverrideDialog orgId={orgId} onClose={() => setAction(null)} onDone={done} />
      )}
      {revoking && (
        <RevokeDialog override={revoking} onClose={() => setRevoking(null)} onDone={done} />
      )}
    </div>
  );
}

/** The currency an amount discount would be in: the account's, or the one its country implies. */
function accountCurrency(d: AdminBillingAccountDetail): string | null {
  if (d.account) return d.account.currency;
  if (d.organization.registeredCountry === 'IN') return 'INR';
  if (d.organization.registeredCountry === 'US') return 'USD';
  return null;
}

type Fact = [string, ReactNode];

function Facts({ rows }: { rows: Fact[] }) {
  return (
    <dl className="grid grid-cols-[auto,1fr] gap-x-4 gap-y-2 text-sm">
      {rows.map(([k, v]) => (
        <div key={k} className="contents">
          <dt className="text-text-secondary">{k}</dt>
          <dd className="text-text-primary">{v}</dd>
        </div>
      ))}
    </dl>
  );
}

// ── Tables ─────────────────────────────────────────────────────────────────────

function EntitlementsTable({ rows }: { rows: ResolvedEntitlement[] }) {
  const columns: Column<ResolvedEntitlement>[] = [
    {
      key: 'name',
      header: 'Feature',
      render: (e) => (
        <div>
          <span className="font-medium">{entitlementLabel(e.key)}</span>
          {e.switchedOffInDeployment && (
            <span className="block text-caption text-status-warning">
              {BILLING_COPY.switchedOff}. The plan or a grant gives it, but it is off for everybody
              here.
            </span>
          )}
        </div>
      ),
    },
    {
      key: 'on',
      header: 'Can use',
      render: (e) =>
        e.enabled ? <Badge tone="success">Yes</Badge> : <Badge tone="neutral">No</Badge>,
    },
    {
      key: 'limit',
      header: 'Limit',
      render: (e) => (e.kind === 'int' && e.limit != null ? e.limit.toLocaleString('en-US') : '-'),
    },
    {
      key: 'source',
      header: 'From',
      render: (e) => ENTITLEMENT_SOURCE_WORDS[e.source] ?? e.source,
    },
  ];
  return (
    <DataTable
      columns={columns}
      rows={rows}
      rowKey={(e) => e.key}
      mobile="cards"
      empty={<EmptyState compact title="No features" />}
    />
  );
}

function overrideIsLive(o: AdminOverrideRow): boolean {
  if (o.revokedAt) return false;
  return !o.endsAt || new Date(o.endsAt).getTime() > Date.now();
}

function OverridesTable({
  rows,
  mayRevoke,
  onRevoke,
}: {
  rows: AdminOverrideRow[];
  mayRevoke: boolean;
  onRevoke: (o: AdminOverrideRow) => void;
}) {
  const columns: Column<AdminOverrideRow>[] = [
    { key: 'name', header: 'Feature', render: (o) => entitlementLabel(o.key) },
    { key: 'value', header: 'Value', render: (o) => entitlementValueText(o) },
    {
      key: 'when',
      header: 'When',
      className: 'whitespace-nowrap',
      render: (o) => `${day(o.startsAt)} to ${o.endsAt ? day(o.endsAt) : 'no end'}`,
    },
    {
      key: 'reason',
      header: 'Reason',
      render: (o) => (
        <div>
          <span>{o.reason}</span>
          {o.revokedAt && (
            <span className="block text-caption text-text-muted">
              Taken back {day(o.revokedAt)}
              {o.revokeReason ? `: ${o.revokeReason}` : ''}
            </span>
          )}
        </div>
      ),
    },
    {
      key: 'state',
      header: 'State',
      render: (o) =>
        overrideIsLive(o) ? (
          <Badge tone="success">In force</Badge>
        ) : (
          <Badge tone="neutral">{o.revokedAt ? 'Taken back' : 'Ended'}</Badge>
        ),
    },
    ...(mayRevoke
      ? [
          {
            key: 'act',
            header: '',
            render: (o: AdminOverrideRow) =>
              overrideIsLive(o) ? (
                <Button size="sm" variant="outline" onClick={() => onRevoke(o)}>
                  Revoke
                </Button>
              ) : null,
          },
        ]
      : []),
  ];
  return (
    <DataTable
      columns={columns}
      rows={rows}
      rowKey={(o) => o.id}
      mobile="cards"
      empty={<EmptyState compact title="No single feature grants" />}
    />
  );
}

function LedgerTable({ rows }: { rows: AdminLedgerRow[] }) {
  const columns: Column<AdminLedgerRow>[] = [
    {
      key: 'at',
      header: 'When',
      className: 'whitespace-nowrap',
      render: (r) => recordedAt(r.createdAt),
    },
    { key: 'what', header: 'What', render: (r) => LEDGER_REASON_WORDS[r.reason] ?? r.reason },
    {
      key: 'delta',
      header: 'Change',
      className: 'tabular-nums',
      render: (r) => (r.delta > 0 ? `+${r.delta}` : String(r.delta)),
    },
    { key: 'period', header: 'Period', render: (r) => r.periodKey },
    { key: 'note', header: 'Note', render: (r) => r.note ?? '-' },
  ];
  return (
    <DataTable
      columns={columns}
      rows={rows}
      rowKey={(r) => r.id}
      mobile="cards"
      empty={<EmptyState compact title="No entries" hint="Nothing was used or given yet." />}
    />
  );
}

type InvoiceRow = AdminBillingAccountDetail['invoices'][number];

function InvoicesTable({ detail }: { detail: AdminBillingAccountDetail }) {
  const columns: Column<InvoiceRow>[] = [
    { key: 'number', header: 'Number', render: (r) => r.number ?? 'Draft' },
    { key: 'status', header: 'State', render: (r) => r.status.toLowerCase() },
    {
      key: 'total',
      header: 'Total',
      className: 'whitespace-nowrap tabular-nums',
      render: (r) => money(r.totalMinor, r.currency),
    },
    {
      key: 'period',
      header: 'Period',
      className: 'whitespace-nowrap',
      render: (r) => (r.periodStart ? `${day(r.periodStart)} to ${day(r.periodEnd)}` : '-'),
    },
    { key: 'issued', header: 'Issued', render: (r) => day(r.issuedAt) },
  ];
  return (
    <DataTable
      columns={columns}
      rows={detail.invoices}
      rowKey={(r) => r.id}
      mobile="cards"
      empty={<EmptyState compact title={BILLING_COPY.noInvoices} />}
    />
  );
}

type PaymentRow = AdminBillingAccountDetail['payments'][number];

function PaymentsTable({ detail }: { detail: AdminBillingAccountDetail }) {
  const columns: Column<PaymentRow>[] = [
    { key: 'at', header: 'When', render: (r) => recordedAt(r.createdAt) },
    {
      key: 'amount',
      header: 'Amount',
      className: 'whitespace-nowrap tabular-nums',
      render: (r) => money(r.amountMinor, r.currency),
    },
    { key: 'status', header: 'State', render: (r) => r.status.toLowerCase() },
    { key: 'provider', header: 'Provider', render: (r) => r.provider },
    { key: 'ref', header: 'Reference', render: (r) => r.providerPaymentRef ?? '-' },
  ];
  return (
    <DataTable
      columns={columns}
      rows={detail.payments}
      rowKey={(r) => r.id}
      mobile="cards"
      empty={<EmptyState compact title="No payments" />}
    />
  );
}

function AdjustmentsTable({ rows }: { rows: AdminAdjustmentRow[] }) {
  const columns: Column<AdminAdjustmentRow>[] = [
    { key: 'kind', header: 'Kind', render: (r) => ADJUSTMENT_KIND_WORDS[r.kind] ?? r.kind },
    {
      key: 'amount',
      header: 'Amount',
      className: 'whitespace-nowrap tabular-nums',
      render: (r) =>
        r.percentOffBps != null
          ? `${bpsText(r.percentOffBps)} off`
          : r.amountMinor != null && r.currency
            ? `${money(r.amountMinor, r.currency)} off`
            : '-',
    },
    {
      key: 'when',
      header: 'When',
      className: 'whitespace-nowrap',
      render: (r) => `${day(r.startsAt)} to ${r.endsAt ? day(r.endsAt) : 'no end'}`,
    },
    { key: 'reason', header: 'Reason', render: (r) => r.reason },
    {
      key: 'state',
      header: 'State',
      render: (r) =>
        r.revokedAt ? <Badge tone="neutral">Taken back</Badge> : <Badge tone="info">On file</Badge>,
    },
  ];
  return (
    <DataTable
      columns={columns}
      rows={rows}
      rowKey={(r) => r.id}
      mobile="cards"
      empty={<EmptyState compact title="No discounts or adjustments" />}
    />
  );
}

function HistoryTable({ rows }: { rows: AdminSubscriptionDetail[] }) {
  const columns: Column<AdminSubscriptionDetail>[] = [
    { key: 'plan', header: 'Plan', render: (s) => planWords(s.plan.code) },
    {
      key: 'status',
      header: 'State',
      render: (s) => <SubscriptionStatusBadge status={s.status} />,
    },
    { key: 'source', header: 'How', render: (s) => subscriptionSourceWords(s.source) },
    { key: 'from', header: 'From', render: (s) => day(s.currentPeriodStart) },
    {
      key: 'to',
      header: 'To',
      render: (s) => day(s.endedAt ?? s.trialEndsAt ?? s.currentPeriodEnd),
    },
    { key: 'note', header: 'Note', render: (s) => s.note ?? '-' },
  ];
  return (
    <DataTable
      columns={columns}
      rows={rows}
      rowKey={(s) => s.id}
      mobile="cards"
      empty={<EmptyState compact title="No plan history" hint="Always on the Free plan." />}
    />
  );
}

// ── Action dialogs ─────────────────────────────────────────────────────────────

/**
 * One action's dialog: its fields, a reason, and a submit that runs only when the form is
 * valid. Mounted only while open, so each open starts empty.
 */
function ActionDialog({
  title,
  description,
  submitLabel,
  onClose,
  onDone,
  valid,
  reason,
  setReason,
  run,
  success,
  children,
  danger,
}: {
  title: string;
  description?: string;
  submitLabel: string;
  onClose: () => void;
  onDone: () => void;
  valid: boolean;
  reason: string;
  setReason: (v: string) => void;
  run: () => Promise<unknown>;
  success: string;
  children?: ReactNode;
  danger?: boolean;
}) {
  const toast = useToast();
  const [tried, setTried] = useState(false);
  const m = useMutation({
    mutationFn: run,
    onSuccess: () => {
      toast.push(success, 'success');
      onDone();
    },
    onError: (e) => toast.push(errorMessage(e), 'error'),
  });
  return (
    <Dialog
      open
      onClose={onClose}
      title={title}
      description={description}
      footer={
        <>
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant={danger ? 'danger' : 'primary'}
            loading={m.isPending}
            onClick={() => {
              setTried(true);
              if (valid && !reasonProblem(reason) && !m.isPending) m.mutate();
            }}
          >
            {submitLabel}
          </Button>
        </>
      }
    >
      <div className="space-y-3">
        {children}
        <ReasonField value={reason} onChange={setReason} tried={tried} />
        {tried && !valid && (
          <p role="alert" className="text-sm text-status-error">
            Check the fields above.
          </p>
        )}
      </div>
    </Dialog>
  );
}

interface DialogProps {
  orgId: string;
  onClose: () => void;
  onDone: () => void;
}

function PlanSelect({
  value,
  onChange,
}: {
  value: 'PRO' | 'PREMIUM';
  onChange: (v: 'PRO' | 'PREMIUM') => void;
}) {
  return (
    <Select
      label="Plan"
      value={value}
      onChange={(e) => onChange(e.target.value as 'PRO' | 'PREMIUM')}
    >
      <option value="PRO">Pro</option>
      <option value="PREMIUM">Premium</option>
    </Select>
  );
}

function TrialDialog({ orgId, onClose, onDone }: DialogProps) {
  const [plan, setPlan] = useState<'PRO' | 'PREMIUM'>('PRO');
  const [days, setDays] = useState('14');
  const [reason, setReason] = useState('');
  const n = wholeNumber(days);
  const daysOk = n != null && n >= 1 && n <= 90;
  return (
    <ActionDialog
      title="Give a trial"
      description="The organization can use the plan free for these days. Then it goes back to Free."
      submitLabel="Give trial"
      success="Trial given."
      onClose={onClose}
      onDone={onDone}
      valid={daysOk}
      reason={reason}
      setReason={setReason}
      run={() =>
        api.admin.billing.grantTrial(orgId, { planCode: plan, days: n!, reason: reason.trim() })
      }
    >
      <PlanSelect value={plan} onChange={setPlan} />
      <Input
        label="Days"
        inputMode="numeric"
        value={days}
        hint="From 1 to 90."
        error={!daysOk ? 'A whole number from 1 to 90.' : undefined}
        onChange={(e) => setDays(e.target.value)}
      />
    </ActionDialog>
  );
}

function ComplimentaryDialog({ orgId, onClose, onDone }: DialogProps) {
  const [plan, setPlan] = useState<'PRO' | 'PREMIUM'>('PRO');
  const [ends, setEnds] = useState('');
  const [reason, setReason] = useState('');
  const endsAt = ends ? endOfDayIso(ends) : null;
  const endsOk = !ends || (endsAt != null && new Date(endsAt).getTime() > Date.now());
  return (
    <ActionDialog
      title="Give a free plan"
      description="The organization gets the plan free of charge. Leave the end date empty to keep it until staff end it."
      submitLabel="Give free plan"
      success="Free plan given."
      onClose={onClose}
      onDone={onDone}
      valid={endsOk}
      reason={reason}
      setReason={setReason}
      run={() =>
        api.admin.billing.grantComplimentary(orgId, {
          planCode: plan,
          endsAt,
          reason: reason.trim(),
        })
      }
    >
      <PlanSelect value={plan} onChange={setPlan} />
      <Input
        label="Ends on (optional)"
        type="date"
        value={ends}
        error={!endsOk ? 'A day in the future.' : undefined}
        onChange={(e) => setEnds(e.target.value)}
      />
    </ActionDialog>
  );
}

function EndGrantDialog({
  orgId,
  sub,
  onClose,
  onDone,
}: DialogProps & { sub: AdminSubscriptionDetail }) {
  const [reason, setReason] = useState('');
  return (
    <ActionDialog
      title="End trial or free plan"
      description={`This ends the ${planWords(sub.plan.code)} ${sub.status === 'TRIALING' ? 'trial' : 'free plan'} now. The organization goes back to the Free plan.`}
      submitLabel="End it now"
      success="Ended. The organization is on the Free plan."
      danger
      onClose={onClose}
      onDone={onDone}
      valid
      reason={reason}
      setReason={setReason}
      run={() => api.admin.billing.endGrant(orgId, reason.trim())}
    />
  );
}

function CreditsDialog({ orgId, onClose, onDone }: DialogProps) {
  const [amount, setAmount] = useState('');
  const [reason, setReason] = useState('');
  // One key per dialog open: a double click, or a retry after a lost answer, grants once.
  const [idempotencyKey] = useState(() => crypto.randomUUID());
  const n = wholeNumber(amount);
  const ok = n != null && n >= 1 && n <= 1_000_000;
  return (
    <ActionDialog
      title="Give email credits"
      description="Extra campaign emails. They are spent after the monthly amount runs out."
      submitLabel="Give credits"
      success="Credits given."
      onClose={onClose}
      onDone={onDone}
      valid={ok}
      reason={reason}
      setReason={setReason}
      run={() =>
        api.admin.billing.grantCredits(orgId, { amount: n!, reason: reason.trim(), idempotencyKey })
      }
    >
      <Input
        label="Number of emails"
        inputMode="numeric"
        value={amount}
        hint="From 1 to 1,000,000."
        error={amount && !ok ? 'A whole number from 1 to 1,000,000.' : undefined}
        onChange={(e) => setAmount(e.target.value)}
      />
    </ActionDialog>
  );
}

function DiscountDialog({
  orgId,
  currency,
  onClose,
  onDone,
}: DialogProps & { currency: string | null }) {
  const [mode, setMode] = useState<'percent' | 'amount'>('percent');
  const [value, setValue] = useState('');
  const [ends, setEnds] = useState('');
  const [reason, setReason] = useState('');
  const bps = mode === 'percent' ? percentToBps(value) : null;
  const minor = mode === 'amount' && currency ? majorToMinor(value, currency) : null;
  const valueOk = mode === 'percent' ? bps != null : minor != null && minor >= 1;
  const endsAt = ends ? endOfDayIso(ends) : null;
  const endsOk = !ends || (endsAt != null && new Date(endsAt).getTime() > Date.now());
  return (
    <ActionDialog
      title="Record a discount"
      description="A discount on this organization's plan payments. Give a percentage or an amount, not both."
      submitLabel="Record discount"
      success="Discount recorded."
      onClose={onClose}
      onDone={onDone}
      valid={valueOk && endsOk}
      reason={reason}
      setReason={setReason}
      run={() =>
        api.admin.billing.recordDiscount(orgId, {
          percentOffBps: mode === 'percent' ? bps : null,
          amountMinor: mode === 'amount' ? minor : null,
          endsAt,
          reason: reason.trim(),
        })
      }
    >
      <Select
        label="Kind of discount"
        value={mode}
        onChange={(e) => {
          setMode(e.target.value as 'percent' | 'amount');
          setValue('');
        }}
      >
        <option value="percent">Percentage off</option>
        <option value="amount" disabled={!currency}>
          Amount off{currency ? ` (${currency})` : ' (no currency known yet)'}
        </option>
      </Select>
      <Input
        label={mode === 'percent' ? 'Percent off' : `Amount off in ${currency ?? ''}`}
        inputMode="decimal"
        value={value}
        hint={
          mode === 'percent'
            ? 'For example 10 or 12.5. Up to 100.'
            : minor != null && currency
              ? `Saved as ${money(minor, currency)}.`
              : 'In rupees or dollars, not paise or cents.'
        }
        error={value && !valueOk ? 'Check this number.' : undefined}
        onChange={(e) => setValue(e.target.value)}
      />
      <Input
        label="Ends on (optional)"
        type="date"
        value={ends}
        error={!endsOk ? 'A day in the future.' : undefined}
        onChange={(e) => setEnds(e.target.value)}
      />
    </ActionDialog>
  );
}

function OverrideDialog({ orgId, onClose, onDone }: DialogProps) {
  const [key, setKey] = useState<string>(ALL_ENTITLEMENT_KEYS[0]);
  const [on, setOn] = useState('true');
  const [amount, setAmount] = useState('');
  const [starts, setStarts] = useState('');
  const [ends, setEnds] = useState('');
  const [reason, setReason] = useState('');
  const kind = entitlementKind(key);
  const n = wholeNumber(amount);
  const valueOk = kind === 'bool' || (n != null && n <= 10_000_000);
  const startsAt = starts ? startOfDayIso(starts) : null;
  const endsAt = ends ? endOfDayIso(ends) : null;
  const datesOk =
    (!ends || (endsAt != null && new Date(endsAt).getTime() > Date.now())) &&
    (!startsAt || !endsAt || startsAt < endsAt);
  return (
    <ActionDialog
      title="Give a single feature"
      description="Turns one feature on or off for this organization, whatever its plan says. The deployment switch still wins."
      submitLabel="Save feature"
      success="Feature saved."
      onClose={onClose}
      onDone={onDone}
      valid={valueOk && datesOk}
      reason={reason}
      setReason={setReason}
      run={() =>
        api.admin.billing.grantOverride(orgId, {
          key,
          ...(kind === 'int' ? { intValue: n! } : { boolValue: on === 'true' }),
          startsAt,
          endsAt,
          reason: reason.trim(),
        })
      }
    >
      <Select label="Feature" value={key} onChange={(e) => setKey(e.target.value)}>
        {ALL_ENTITLEMENT_KEYS.map((k) => (
          <option key={k} value={k}>
            {ENTITLEMENT_DEFINITIONS[k].label}
          </option>
        ))}
      </Select>
      {kind === 'int' ? (
        <Input
          label="Number"
          inputMode="numeric"
          value={amount}
          hint={ENTITLEMENT_DEFINITIONS[key as keyof typeof ENTITLEMENT_DEFINITIONS]?.description}
          error={amount && !valueOk ? 'A whole number.' : undefined}
          onChange={(e) => setAmount(e.target.value)}
        />
      ) : (
        <Select label="Value" value={on} onChange={(e) => setOn(e.target.value)}>
          <option value="true">On</option>
          <option value="false">Off</option>
        </Select>
      )}
      <div className="grid gap-3 sm:grid-cols-2">
        <Input
          label="Starts on (optional)"
          type="date"
          value={starts}
          hint="Empty means now."
          onChange={(e) => setStarts(e.target.value)}
        />
        <Input
          label="Ends on (optional)"
          type="date"
          value={ends}
          hint="Empty means no end."
          error={!datesOk ? 'A future day after the start.' : undefined}
          onChange={(e) => setEnds(e.target.value)}
        />
      </div>
    </ActionDialog>
  );
}

function RevokeDialog({
  override,
  onClose,
  onDone,
}: {
  override: AdminOverrideRow;
  onClose: () => void;
  onDone: () => void;
}) {
  const [reason, setReason] = useState('');
  return (
    <ActionDialog
      title="Revoke this feature grant"
      description={`${entitlementLabel(override.key)}: ${entitlementValueText(override)}. The organization goes back to what its plan gives.`}
      submitLabel="Revoke"
      success="Grant revoked."
      danger
      onClose={onClose}
      onDone={onDone}
      valid
      reason={reason}
      setReason={setReason}
      run={() => api.admin.billing.revokeOverride(override.id, reason.trim())}
    />
  );
}
