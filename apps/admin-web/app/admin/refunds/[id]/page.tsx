'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useParams } from 'next/navigation';
import { useState } from 'react';
import {
  api,
  Card,
  Button,
  Skeleton,
  PageHeader,
  EmptyState,
  ErrorState,
  Dialog,
  ButtonLink,
  money,
  dateTime,
  useToast,
  errorMessage,
  type RefundRetryResult,
} from '@eticketsgo/web-kit';
import { retryOutcomeText, retrySucceeded } from '@/lib/refund-retry';
import { accountContactText } from '../../../../components/account-contact';
import { MoneyStatusPill } from '@/components/money-status';
import { RecordHistory, useRecordHistory } from '@/components/record-history';
import { failedRefundAdvice, type HistoryEntry } from '@/lib/history';
import { moneyStatusLabel } from '@/lib/money-status';

export default function RefundDetail() {
  const { id } = useParams<{ id: string }>();
  const qc = useQueryClient();
  const toast = useToast();
  const [confirmApprove, setConfirmApprove] = useState(false);
  const [confirmReject, setConfirmReject] = useState(false);
  const [lastRetry, setLastRetry] = useState<RefundRetryResult | null>(null);

  /*
    Read by id. This used to look for the refund inside the newest hundred rows of the list,
    so an older request — the kind most likely to need chasing — showed "not found".
  */
  const isNotFound = (e: unknown) => (e as { code?: string } | null)?.code === 'NOT_FOUND';
  const refundQ = useQuery({
    queryKey: ['admin', 'refunds', 'detail', id],
    queryFn: () => api.admin.refund(id),
    // A refund that does not exist will not start existing on a retry.
    retry: (count, e) => !isNotFound(e) && count < 2,
  });
  const refund = refundQ.data;
  /*
    The refund's own history, and the failure advice read from it. Called before the early
    returns below, as hooks must be; it waits for the refund to load.
  */
  const history = useRecordHistory(refund ? [`Refund:${refund.id}`] : []);

  const process = useMutation({
    mutationFn: (decision: 'APPROVE' | 'REJECT') => api.refunds.process(id, decision),
    onSuccess: (_r, decision) => {
      toast.push(`Refund ${decision === 'APPROVE' ? 'approved' : 'rejected'}.`, 'success');
      setConfirmApprove(false);
      setConfirmReject(false);
      qc.invalidateQueries({ queryKey: ['admin', 'refunds'] });
    },
    onError: (e) => toast.push(errorMessage(e), 'error'),
  });

  if (refundQ.isError && !isNotFound(refundQ.error))
    return (
      <ErrorState
        message="We couldn't load this. Please try again."
        onRetry={() => refundQ.refetch()}
      />
    );
  if (refundQ.isLoading) return <Skeleton className="h-64 w-full" />;
  if (!refund)
    return (
      <EmptyState
        title="Refund not found"
        hint="Check the link, or find it in the refunds list."
        action={<ButtonLink href="/admin/refunds">Back to refunds</ButtonLink>}
      />
    );

  return (
    <div className="space-y-6">
      {/*
        Named by the booking the customer quotes and the event, not by eight characters of a
        database id ("cmtyssm9" was the breadcrumb).
      */}
      <PageHeader
        title={`Refund for ${refund.booking?.reference ?? 'a booking with no reference'}`}
        description={refund.booking?.event?.title}
        breadcrumbs={[
          { label: 'Refunds', href: '/admin/refunds' },
          { label: refund.booking?.reference ?? 'Refund' },
        ]}
      />

      {refund.status === 'FAILED' && (
        <FailedRefundPanel
          entries={(history.data?.data ?? []) as HistoryEntry[]}
          loading={history.isLoading}
          paymentRef={refund.booking?.payment?.providerRef ?? null}
          provider={refund.booking?.payment?.provider ?? null}
          refundRef={refund.providerRef ?? null}
        />
      )}

      {/*
        Try again. There was no way to: a FAILED refund was a dead end and the page could only
        say "pay the customer by hand from the provider dashboard". Shown while it is FAILED, and
        afterwards with what the provider answered, so the admin sees the result where they acted.
      */}
      {(refund.status === 'FAILED' || lastRetry) && (
        <RetryRefundCard
          refundId={refund.id}
          failed={refund.status === 'FAILED'}
          amount={money(refund.amountMinor, refund.booking?.currency)}
          buyer={accountContactText(refund.booking?.buyerEmail) ?? 'the buyer'}
          provider={providerName(refund.booking?.payment?.provider ?? '')}
          paymentRef={refund.booking?.payment?.providerRef ?? null}
          lastRetry={lastRetry}
          onDone={(result) => {
            setLastRetry(result);
            qc.invalidateQueries({ queryKey: ['admin', 'refunds'] });
            qc.invalidateQueries({ queryKey: ['admin', 'audit'] });
          }}
        />
      )}

      <div className="grid gap-6 lg:grid-cols-3">
        <Card title="Details" className="lg:col-span-2">
          <dl className="space-y-2 text-sm">
            <div className="flex justify-between">
              <dt className="text-text-muted">Status</dt>
              <dd>
                <MoneyStatusPill entity="refund" status={refund.status} />
              </dd>
            </div>
            <div className="flex justify-between">
              <dt className="text-text-muted">Amount</dt>
              <dd className="font-semibold text-text-primary">
                {money(refund.amountMinor, refund.booking?.currency)}
              </dd>
            </div>
            <div className="flex justify-between">
              <dt className="text-text-muted">Buyer</dt>
              <dd className="text-text-primary">
                {accountContactText(refund.booking?.buyerEmail) ?? '—'}
              </dd>
            </div>
            <div className="flex justify-between">
              <dt className="text-text-muted">Tickets</dt>
              <dd className="text-text-primary">{refund.ticketIds.length}</dd>
            </div>
            <div className="flex justify-between">
              <dt className="text-text-muted">Requested</dt>
              <dd className="text-text-primary">{dateTime(refund.createdAt)}</dd>
            </div>
            {refund.booking?.payment && (
              <div className="flex justify-between gap-4">
                <dt className="text-text-muted">Paid with</dt>
                <dd className="text-right text-text-primary">
                  {providerName(refund.booking.payment.provider)}
                  {refund.booking.payment.providerRef && (
                    <span className="block break-all font-mono text-caption text-text-muted">
                      {refund.booking.payment.providerRef}
                    </span>
                  )}
                </dd>
              </div>
            )}
          </dl>
          <p className="mt-4 rounded-md bg-background-subtle p-3 text-sm text-text-secondary">
            {refund.reason}
          </p>
          <ButtonLink
            href={`/admin/bookings/${refund.bookingId}`}
            variant="outline"
            className="mt-4"
          >
            View booking
          </ButtonLink>
        </Card>

        <Card title="Decision">
          {refund.status === 'REQUESTED' ? (
            <div className="space-y-2">
              <Button
                className="w-full"
                loading={process.isPending && process.variables === 'APPROVE'}
                disabled={process.isPending}
                onClick={() => setConfirmApprove(true)}
              >
                Approve & refund
              </Button>
              <Button
                variant="danger"
                className="w-full"
                loading={process.isPending && process.variables === 'REJECT'}
                disabled={process.isPending}
                onClick={() => setConfirmReject(true)}
              >
                Reject
              </Button>
            </div>
          ) : (
            <p className="text-sm text-text-muted">
              {DECIDED[refund.status] ?? `${moneyStatusLabel('refund', refund.status)}.`}
            </p>
          )}
        </Card>
      </div>

      <Dialog
        open={confirmApprove}
        onClose={() => setConfirmApprove(false)}
        title="Approve this refund?"
        footer={
          <>
            <Button variant="outline" onClick={() => setConfirmApprove(false)}>
              Cancel
            </Button>
            <Button
              loading={process.isPending && process.variables === 'APPROVE'}
              onClick={() => process.mutate('APPROVE')}
            >
              Approve &amp; refund
            </Button>
          </>
        }
      >
        <p>
          This will refund <strong>{money(refund.amountMinor, refund.booking?.currency)}</strong> to{' '}
          {accountContactText(refund.booking?.buyerEmail) ?? 'the buyer'}. This action cannot be
          undone.
        </p>
      </Dialog>

      {/* Rejecting used to happen on the first click, with no second look. */}
      <Dialog
        open={confirmReject}
        onClose={() => setConfirmReject(false)}
        title="Turn this refund down?"
        footer={
          <>
            <Button variant="outline" onClick={() => setConfirmReject(false)}>
              Cancel
            </Button>
            <Button
              variant="danger"
              loading={process.isPending && process.variables === 'REJECT'}
              onClick={() => process.mutate('REJECT')}
            >
              Turn it down
            </Button>
          </>
        }
      >
        <p className="text-sm text-text-secondary">
          {accountContactText(refund.booking?.buyerEmail) ?? 'The buyer'} keeps their tickets and is
          not paid anything back.
        </p>
      </Dialog>

      <RecordHistory subjects={[`Refund:${refund.id}`]} />
    </div>
  );
}

/** What each decided state means, said once rather than "This refund is completed." */
const DECIDED: Record<string, string> = {
  COMPLETED: 'Paid back to the customer.',
  REJECTED: 'Turned down. The customer kept their tickets.',
  PROCESSING: 'Sent to the payment provider. It becomes Refunded when the provider confirms it.',
  APPROVED: 'Approved and waiting to be sent to the payment provider.',
  FAILED: 'Did not go through. See above for what to do.',
};

function providerName(provider: string): string {
  return provider === 'razorpay'
    ? 'Razorpay'
    : provider === 'stripe'
      ? 'Stripe'
      : provider === 'mock'
        ? 'Test payment (no real money)'
        : provider;
}

/** The dead end, opened up: why it failed, and who has to do what next. */
function FailedRefundPanel({
  entries,
  loading,
  paymentRef,
  provider,
  refundRef,
}: {
  entries: HistoryEntry[];
  loading: boolean;
  paymentRef: string | null;
  provider: string | null;
  refundRef: string | null;
}) {
  if (loading) return <Skeleton className="h-24 w-full" />;
  const advice = failedRefundAdvice(entries);
  return (
    <Card title="This refund did not go through" className="border-status-error/40">
      <div className="space-y-3 text-sm">
        <p className="text-text-primary">{advice.cause}</p>
        <ol className="list-decimal space-y-1 pl-5 text-text-secondary">
          {advice.steps.map((step) => (
            <li key={step}>{step}</li>
          ))}
        </ol>
        <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-caption">
          {provider && (
            <>
              <dt className="text-text-muted">Provider</dt>
              <dd className="text-text-primary">{providerName(provider)}</dd>
            </>
          )}
          <dt className="text-text-muted">Payment reference</dt>
          <dd className="break-all font-mono text-text-primary">{paymentRef ?? 'None recorded'}</dd>
          {/* A refused refund can come back carrying the payment's own reference; once is enough. */}
          {refundRef && refundRef !== paymentRef && (
            <>
              <dt className="text-text-muted">Refund reference</dt>
              <dd className="break-all font-mono text-text-primary">{refundRef}</dd>
            </>
          )}
        </dl>
      </div>
    </Card>
  );
}

/** Send a failed refund to the provider again, or say exactly why that cannot be done. */
function RetryRefundCard({
  refundId,
  failed,
  amount,
  buyer,
  provider,
  paymentRef,
  lastRetry,
  onDone,
}: {
  refundId: string;
  failed: boolean;
  amount: string;
  buyer: string;
  provider: string;
  paymentRef: string | null;
  lastRetry: RefundRetryResult | null;
  onDone: (r: RefundRetryResult) => void;
}) {
  const toast = useToast();
  const [open, setOpen] = useState(false);
  const [checked, setChecked] = useState(false);
  const check = useQuery({
    queryKey: ['admin', 'refunds', 'retry-check', refundId],
    queryFn: () => api.admin.refundRetryCheck(refundId),
    enabled: failed,
    retry: false,
  });
  const retry = useMutation({
    mutationFn: () =>
      api.admin.retryRefund(
        refundId,
        check.data?.needsConfirmation ? { confirmedNoProviderRefund: true } : {},
      ),
    onSuccess: (r) => {
      setOpen(false);
      setChecked(false);
      toast.push(retryOutcomeText(r), retrySucceeded(r) ? 'success' : 'error');
      check.refetch();
      onDone(r);
    },
    onError: (e) => {
      setOpen(false);
      toast.push(errorMessage(e), 'error');
      check.refetch();
    },
  });
  const a = check.data;
  const canTry = !!a && (a.allowed || a.needsConfirmation);

  return (
    <Card title="Try the refund again">
      <div className="space-y-3 text-sm">
        {lastRetry && (
          <div
            role="status"
            className={`rounded-md border p-3 ${
              retrySucceeded(lastRetry)
                ? 'border-status-success/40 bg-status-success/10'
                : 'border-status-error/40 bg-status-error/5'
            }`}
          >
            <p className="font-semibold text-text-primary">
              Last try: {retryOutcomeText(lastRetry)}
            </p>
            {lastRetry.providerRef && (
              <p className="mt-1 text-caption text-text-secondary">
                Provider reference{' '}
                <span className="break-all font-mono">{lastRetry.providerRef}</span>
              </p>
            )}
            {lastRetry.message &&
              (lastRetry.outcome === 'FAILED' || lastRetry.outcome === 'ERROR') && (
                <p className="mt-1 break-words text-caption text-text-secondary">
                  Provider said: {lastRetry.message}
                </p>
              )}
          </div>
        )}
        {failed && check.isLoading && <Skeleton className="h-10 w-full" />}
        {failed && check.isError && (
          <p className="text-text-secondary">
            We could not check whether this refund can be tried again. {errorMessage(check.error)}
          </p>
        )}
        {failed && a && <p className="text-text-primary">{a.message}</p>}
        {failed && canTry && (
          <Button onClick={() => setOpen(true)} disabled={retry.isPending}>
            Try the refund again
          </Button>
        )}
      </div>

      <Dialog
        open={open}
        onClose={() => setOpen(false)}
        title="Send this refund again?"
        footer={
          <>
            <Button variant="outline" onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button
              loading={retry.isPending}
              disabled={!!a?.needsConfirmation && !checked}
              onClick={() => retry.mutate()}
            >
              Send {amount} again
            </Button>
          </>
        }
      >
        <div className="space-y-3 text-sm text-text-secondary">
          <p>
            This asks {provider || 'the payment provider'} to pay <strong>{amount}</strong> back to{' '}
            {buyer}. It is sent once; a second click is refused while it is being sent.
          </p>
          {a?.stage === 'TICKETS_RETURNED' && (
            <p>The tickets were already cancelled, so only the money is sent.</p>
          )}
          {a?.needsConfirmation && (
            <label className="flex items-start gap-2 rounded-md border border-border p-3 text-text-primary">
              <input
                type="checkbox"
                className="mt-1"
                checked={checked}
                onChange={(e) => setChecked(e.target.checked)}
              />
              <span>
                I looked up payment{' '}
                <span className="break-all font-mono">{paymentRef ?? 'for this booking'}</span> in
                the {provider || 'provider'} dashboard and there is no refund for it.
              </span>
            </label>
          )}
        </div>
      </Dialog>
    </Card>
  );
}
