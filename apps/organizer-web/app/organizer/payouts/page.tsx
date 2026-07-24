'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Suspense, useEffect, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import { AlertTriangle, Banknote, CheckCircle2, ExternalLink, XCircle } from 'lucide-react';
import {
  api,
  Badge,
  Button,
  Card,
  DataTable,
  Dialog,
  Skeleton,
  StatusBadge,
  ErrorState,
  PageHeader,
  money,
  dateOnly,
  titleCase,
  useToast,
  errorMessage,
  type Column,
  type Payout,
} from '@eticketsgo/web-kit';
import { useOrg } from '@/components/org-context';

export default function PayoutsPage() {
  return (
    <Suspense fallback={<Skeleton className="h-40" />}>
      <PayoutsInner />
    </Suspense>
  );
}

function PayoutsInner() {
  const { activeOrg } = useOrg();
  const qc = useQueryClient();
  const toast = useToast();
  const [confirmOpen, setConfirmOpen] = useState(false);

  const { data, isLoading, isError, refetch } = useQuery({
    queryKey: ['payouts', activeOrg.id],
    queryFn: () => api.payouts.forOrg(activeOrg.id),
  });

  const generate = useMutation({
    mutationFn: () => api.payouts.generate(activeOrg.id),
    onSuccess: () => {
      toast.push('Settlement generated.', 'success');
      qc.invalidateQueries({ queryKey: ['payouts', activeOrg.id] });
      setConfirmOpen(false);
    },
    onError: (e) => toast.push(errorMessage(e), 'error'),
  });

  const columns: Column<Payout>[] = [
    { key: 'created', header: 'Created', render: (p) => dateOnly(p.createdAt) },
    { key: 'gross', header: 'Gross', render: (p) => money(p.grossMinor) },
    { key: 'fees', header: 'Fees', render: (p) => money(p.bookingFeeMinor + p.paymentFeeMinor) },
    { key: 'refunds', header: 'Refunds', render: (p) => money(p.refundMinor) },
    {
      key: 'net',
      header: 'Net',
      render: (p) => <span className="font-semibold">{money(p.netMinor)}</span>,
    },
    { key: 'status', header: 'Status', render: (p) => <StatusBadge status={p.status} /> },
    { key: 'paid', header: 'Paid', render: (p) => (p.paidAt ? dateOnly(p.paidAt) : '—') },
  ];

  return (
    <div className="space-y-6">
      <PageHeader
        title="Payouts"
        description="Connect your Stripe account and review settlement records for your organization."
      />

      <StripePayoutSetup orgId={activeOrg.id} />

      <div className="space-y-4">
        <div className="flex items-center justify-between gap-3">
          <h2 className="text-title font-semibold text-text-primary">Settlements</h2>
          <Button loading={generate.isPending} onClick={() => setConfirmOpen(true)}>
            Generate settlement
          </Button>
        </div>
        <DataTable
          columns={columns}
          rows={data}
          loading={isLoading}
          rowKey={(p) => p.id}
          error={isError ? "We couldn't load this. Please try again." : undefined}
          onRetry={() => refetch()}
          empty={
            <div className="p-8 text-center text-text-muted">
              No payouts yet. Generate a settlement to preview your net revenue.
            </div>
          }
        />
      </div>

      <Dialog
        open={confirmOpen}
        onClose={() => setConfirmOpen(false)}
        title="Generate settlement?"
        footer={
          <>
            <Button
              variant="outline"
              onClick={() => setConfirmOpen(false)}
              disabled={generate.isPending}
            >
              Cancel
            </Button>
            <Button loading={generate.isPending} onClick={() => generate.mutate()}>
              Generate
            </Button>
          </>
        }
      >
        This creates a new settlement record for {activeOrg.name} covering all unsettled revenue.
        Continue?
      </Dialog>
    </div>
  );
}

/** Charges/payouts enablement pill (colour dot + label, never colour alone). */
function EnabledBadge({ label, on }: { label: string; on: boolean }) {
  return (
    <Badge tone={on ? 'success' : 'neutral'}>
      {on ? <CheckCircle2 className="h-3.5 w-3.5" /> : <XCircle className="h-3.5 w-3.5" />}
      {label}
    </Badge>
  );
}

function StripePayoutSetup({ orgId }: { orgId: string }) {
  const params = useSearchParams();
  const onboarding = params.get('onboarding'); // 'return' | 'refresh' | null
  const toast = useToast();

  const {
    data: status,
    isLoading,
    isError,
    refetch,
  } = useQuery({
    queryKey: ['org-payments-status', orgId],
    queryFn: () => api.organizerPayments.status(orgId),
  });

  // Re-fetch when Stripe sends the organizer back from the hosted onboarding flow.
  useEffect(() => {
    if (onboarding === 'return' || onboarding === 'refresh') void refetch();
  }, [onboarding, refetch]);

  const startOnboarding = useMutation({
    mutationFn: () => api.organizerPayments.onboardingLink(orgId),
    onSuccess: ({ url }) => {
      window.location.href = url;
    },
    onError: (e) => toast.push(errorMessage(e), 'error'),
  });

  const openDashboard = useMutation({
    mutationFn: () => api.organizerPayments.dashboardLink(orgId),
    onSuccess: ({ url }) => {
      window.location.href = url;
    },
    onError: (e) => toast.push(errorMessage(e), 'error'),
  });

  if (isLoading) {
    return (
      <Card title="Payouts (Stripe)">
        <Skeleton className="h-28" />
      </Card>
    );
  }
  if (isError || !status) {
    return (
      <Card title="Payouts (Stripe)">
        <ErrorState
          message="We couldn't load your payout status. Please try again."
          onRetry={() => refetch()}
        />
      </Card>
    );
  }

  const needsSetup = !status.hasAccount || !status.chargesEnabled || !status.payoutsEnabled;

  return (
    <Card
      title="Payouts (Stripe)"
      action={
        <div className="flex flex-wrap justify-end gap-2">
          {needsSetup && (
            <Button loading={startOnboarding.isPending} onClick={() => startOnboarding.mutate()}>
              <Banknote className="h-4 w-4" />
              {status.hasAccount ? 'Continue payout setup' : 'Set up payouts'}
            </Button>
          )}
          {status.chargesEnabled && (
            <Button
              variant="outline"
              loading={openDashboard.isPending}
              onClick={() => openDashboard.mutate()}
            >
              <ExternalLink className="h-4 w-4" /> View Stripe dashboard
            </Button>
          )}
        </div>
      }
    >
      <div className="space-y-4">
        {!status.canSellPaidTickets && (
          <div className="flex items-start gap-2 rounded-md border border-status-warning/30 bg-status-warning/8 px-4 py-3 text-sm text-status-warning">
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
            <span>You must finish payout setup before you can sell paid tickets.</span>
          </div>
        )}

        <dl className="grid gap-4 sm:grid-cols-2">
          <div>
            <dt className="text-caption text-text-muted">Onboarding status</dt>
            <dd className="mt-1">
              <StatusBadge status={status.onboardingStatus} />
            </dd>
          </div>
          <div>
            <dt className="text-caption text-text-muted">Account</dt>
            <dd className="mt-1 flex flex-wrap gap-2">
              <EnabledBadge label="Charges" on={status.chargesEnabled} />
              <EnabledBadge label="Payouts" on={status.payoutsEnabled} />
              <EnabledBadge label="Details submitted" on={status.detailsSubmitted} />
            </dd>
          </div>
        </dl>

        {status.disabledReason && (
          <p className="text-sm text-status-error">
            <span className="font-medium">Account restricted:</span>{' '}
            {titleCase(status.disabledReason.replaceAll('.', ' '))}
          </p>
        )}

        {status.requirementsDue.length > 0 && (
          <div>
            <p className="mb-1.5 text-caption font-medium text-text-muted">
              Information still required
            </p>
            <ul className="list-disc space-y-0.5 pl-5 text-sm text-text-secondary">
              {status.requirementsDue.map((req) => (
                <li key={req}>{titleCase(req.replaceAll('.', ' ').replaceAll('_', ' '))}</li>
              ))}
            </ul>
          </div>
        )}

        <p className="text-caption text-text-muted">
          Payouts are handled by Stripe ({status.country?.toUpperCase()} ·{' '}
          {status.currency?.toUpperCase()}). ETicketsGo never stores your bank details.
        </p>
      </div>
    </Card>
  );
}
