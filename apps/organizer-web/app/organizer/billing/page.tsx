'use client';

import { useEffect, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { AlertTriangle, CheckCircle2, Clock, CreditCard, Info, ReceiptText } from 'lucide-react';
import { ENTITLEMENT_DEFINITIONS } from '@eticketsgo/shared-types';
import {
  api,
  Badge,
  Button,
  Card,
  Dialog,
  EmptyState,
  ErrorState,
  PageHeader,
  Skeleton,
  Textarea,
  dateOnly,
  errorMessage,
  money,
  useToast,
  type BillingPlanSummary,
} from '@eticketsgo/web-kit';
import { useOrg } from '@/components/org-context';
import {
  ASK_DIALOG_TEXT,
  CANCEL_DIALOG_TEXT,
  CONFIRM_POLL_LIMIT,
  CONFIRM_POLL_MS,
  DISPUTED_NOTICE,
  NO_INVOICES,
  PAID_PLANS_CLOSED,
  PAYMENT_CONFIRMED,
  PAYMENT_NOT_CONFIRMED_YET,
  RETURN_MESSAGES,
  checkoutReturn,
  paidPlanConfirmed,
  paidPlanControls,
  type CheckoutReturn,
  PLAN_NAMES,
  planFeatureLines,
  planStatusSentence,
  priceLabel,
  upgradeAction,
  usageSentence,
} from '@/lib/billing-plans';

/**
 * Billing & plans: the plan this organization is on, what it includes, what is left this
 * month, the plans it could move to at this country's prices, and its platform invoices.
 *
 * ── WHAT THIS REPLACES ─────────────────────────────────────────────────────────────
 * "Premium & enterprise" (/organizer/premium, which now redirects here) said in its own
 * comments that no entitlement model existed. One does now: the API resolves what each
 * organization may use from its plan, staff grants and the deployment's switches, and this page
 * shows that answer rather than a build-time flag.
 *
 * ── COMING BACK FROM THE PROVIDER ──────────────────────────────────────────────────
 * The provider sends the organizer back with ?checkout=success (or credits=success). That is
 * only a hint for which message to show: the page then asks the SERVER every few seconds, and
 * says "confirmed" only when the server reports the paid plan active - which happens only after
 * the provider's verified payment reached the webhook. It never trusts the redirect.
 *
 * ── NO DEAD BUTTONS ────────────────────────────────────────────────────────────────
 * While paid plans are not open (BILLING_ENABLED off, the default), every plan offers "Ask about
 * <plan>", which sends a message to support through the channel that already exists. Nothing on
 * this page pretends a payment can be made. The API refuses checkout either way.
 */
export default function BillingPage() {
  const { activeOrg, activeOrgSentenceName } = useOrg();
  const toast = useToast();
  const [asking, setAsking] = useState<BillingPlanSummary | null>(null);
  const [note, setNote] = useState('');
  const [sending, setSending] = useState(false);
  const [paying, setPaying] = useState<string | null>(null);
  const [returned, setReturned] = useState<CheckoutReturn>(null);
  const [pollUntil, setPollUntil] = useState(0);
  const [cancelling, setCancelling] = useState(false);
  const [cancelOpen, setCancelOpen] = useState(false);

  // Read the provider's redirect once, then drop it from the address bar so a reload does not
  // show "confirming" again.
  useEffect(() => {
    const r = checkoutReturn(window.location.search);
    if (!r) return;
    setReturned(r);
    if (r === 'plan-success' || r === 'credits-success') {
      setPollUntil(Date.now() + CONFIRM_POLL_MS * CONFIRM_POLL_LIMIT);
    }
    window.history.replaceState(null, '', window.location.pathname);
  }, []);

  // Re-render once the confirmation window closes, so "confirming" turns into "not yet".
  const [, setTick] = useState(0);
  useEffect(() => {
    if (!pollUntil) return;
    const t = setTimeout(() => setTick((n) => n + 1), Math.max(0, pollUntil - Date.now()) + 50);
    return () => clearTimeout(t);
  }, [pollUntil]);

  const billing = useQuery({
    queryKey: ['billing', activeOrg.id],
    queryFn: () => api.billing.get(activeOrg.id),
    // While confirming a payment, ask the server again every few seconds, for a bounded time.
    refetchInterval: (q) => {
      if (Date.now() > pollUntil) return false;
      if (returned === 'plan-success' && q.state.data && paidPlanConfirmed(q.state.data)) {
        return false;
      }
      return CONFIRM_POLL_MS;
    },
  });
  const invoices = useQuery({
    queryKey: ['billing-invoices', activeOrg.id],
    queryFn: () => api.billing.invoices(activeOrg.id),
  });

  const send = async () => {
    if (!asking) return;
    setSending(true);
    try {
      await api.support.submit({
        kind: 'FEATURE',
        message:
          `Plan interest: ${asking.name}\n` +
          `Organization: ${activeOrgSentenceName} (${activeOrg.id})\n\n` +
          (note.trim() || 'No additional details.'),
      });
      toast.push('Thanks. We will contact you about this plan.', 'success');
      setAsking(null);
      setNote('');
    } catch (err) {
      toast.push(errorMessage(err), 'error');
    } finally {
      setSending(false);
    }
  };

  const checkout = async (priceId: string) => {
    setPaying(priceId);
    try {
      const session = await api.billing.checkout(activeOrg.id, priceId);
      window.location.assign(session.url);
    } catch (err) {
      toast.push(errorMessage(err), 'error');
      setPaying(null);
    }
  };

  const buyCredits = async (packCode: string) => {
    setPaying(packCode);
    try {
      const session = await api.billing.buyCredits(activeOrg.id, packCode);
      window.location.assign(session.url);
    } catch (err) {
      toast.push(errorMessage(err), 'error');
      setPaying(null);
    }
  };

  const openPortal = async () => {
    setPaying('portal');
    try {
      const portal = await api.billing.portal(activeOrg.id);
      window.location.assign(portal.url);
    } catch (err) {
      toast.push(errorMessage(err), 'error');
      setPaying(null);
    }
  };

  const cancelPlan = async () => {
    setCancelling(true);
    try {
      await api.billing.cancel(activeOrg.id);
      toast.push(
        'Your plan will not renew. It stays active until the end of the period.',
        'success',
      );
      setCancelOpen(false);
      await billing.refetch();
    } catch (err) {
      toast.push(errorMessage(err), 'error');
    } finally {
      setCancelling(false);
    }
  };

  const viewInvoice = async (invoiceId: string) => {
    try {
      await api.billing.openInvoiceHtml(activeOrg.id, invoiceId);
    } catch (err) {
      toast.push(errorMessage(err), 'error');
    }
  };

  const header = (
    <PageHeader
      title="Billing & plans"
      description="Your plan, what it includes and what is left this month. Selling tickets is never part of a plan."
    />
  );

  if (billing.isLoading) {
    return (
      <div className="space-y-6">
        {header}
        <Skeleton className="h-32" />
        <Skeleton className="h-64" />
      </div>
    );
  }
  if (billing.isError || !billing.data) {
    return (
      <div className="space-y-6">
        {header}
        <ErrorState message={errorMessage(billing.error)} onRetry={() => void billing.refetch()} />
      </div>
    );
  }

  const b = billing.data;
  const included = b.entitlements.filter((e) => e.enabled || e.switchedOffInDeployment);
  const controls = paidPlanControls(b);
  const confirmed = paidPlanConfirmed(b);
  const stillPolling = Date.now() <= pollUntil;
  const returnMessage =
    returned === 'plan-success'
      ? confirmed
        ? PAYMENT_CONFIRMED
        : stillPolling
          ? RETURN_MESSAGES['plan-success']
          : PAYMENT_NOT_CONFIRMED_YET
      : returned
        ? RETURN_MESSAGES[returned]
        : null;
  const packs = b.billingEnabled ? (b.creditPacks ?? []) : [];

  return (
    <div className="space-y-6">
      {header}

      {!b.billingEnabled && (
        <Card>
          <div className="flex items-start gap-3">
            <Info className="mt-0.5 h-5 w-5 shrink-0 text-action-primary" aria-hidden />
            <p className="text-[0.9375rem] text-text-secondary">{PAID_PLANS_CLOSED}</p>
          </div>
        </Card>
      )}

      {returnMessage && (
        <Card>
          <div className="flex items-start gap-3" role="status" aria-live="polite">
            {returned === 'plan-success' && confirmed ? (
              <CheckCircle2 className="mt-0.5 h-5 w-5 shrink-0 text-status-success" aria-hidden />
            ) : (
              <Info className="mt-0.5 h-5 w-5 shrink-0 text-action-primary" aria-hidden />
            )}
            <p className="text-[0.9375rem] text-text-secondary">{returnMessage}</p>
          </div>
        </Card>
      )}

      {b.disputed && (
        <Card>
          <div className="flex items-start gap-3">
            <AlertTriangle className="mt-0.5 h-5 w-5 shrink-0 text-status-warning" aria-hidden />
            <p className="text-[0.9375rem] text-text-secondary">{DISPUTED_NOTICE}</p>
          </div>
        </Card>
      )}

      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <p className="text-caption uppercase tracking-wide text-text-muted">Your plan</p>
          <p className="mt-1 text-2xl font-semibold text-text-primary">
            {PLAN_NAMES[b.currentPlanCode]}
          </p>
          <p className="mt-2 text-[0.9375rem] text-text-secondary">{planStatusSentence(b)}</p>
          {(controls.portal || controls.cancel) && (
            <div className="mt-4 flex flex-wrap gap-2">
              {controls.portal && (
                <Button
                  variant="outline"
                  size="sm"
                  loading={paying === 'portal'}
                  onClick={() => void openPortal()}
                >
                  <CreditCard className="h-4 w-4" aria-hidden />
                  Manage payment method
                </Button>
              )}
              {controls.cancel && (
                <Button variant="outline" size="sm" onClick={() => setCancelOpen(true)}>
                  Cancel plan
                </Button>
              )}
            </div>
          )}
        </Card>
        <Card>
          <p className="text-caption uppercase tracking-wide text-text-muted">Campaign emails</p>
          <p className="mt-2 text-[0.9375rem] text-text-secondary">{usageSentence(b.usage)}</p>
        </Card>
      </div>

      <Card>
        <h2 className="font-semibold text-text-primary">What your plan includes</h2>
        <ul className="mt-3 space-y-2">
          {included.map((e) => (
            <li key={e.key} className="flex items-start gap-2 text-[0.9375rem]">
              {e.enabled ? (
                <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-status-success" aria-hidden />
              ) : (
                <Clock className="mt-0.5 h-4 w-4 shrink-0 text-text-muted" aria-hidden />
              )}
              <span>
                <span className="font-medium text-text-primary">
                  {ENTITLEMENT_DEFINITIONS[e.key].label}
                  {e.kind === 'int' && e.limit ? `: ${e.limit.toLocaleString('en-US')}` : ''}
                </span>
                {e.switchedOffInDeployment && (
                  <span className="text-text-muted"> - included, not switched on yet</span>
                )}
              </span>
            </li>
          ))}
        </ul>
      </Card>

      <section aria-labelledby="compare-plans" className="space-y-3">
        <h2 id="compare-plans" className="font-semibold text-text-primary">
          Compare plans
        </h2>
        {!b.country && (
          <p className="text-[0.9375rem] text-text-muted">
            Add your registered country in Settings to see prices for your country.
          </p>
        )}
        <div className="grid gap-4 md:grid-cols-3">
          {b.plans.map((plan) => {
            const action = upgradeAction(b, plan);
            return (
              <Card key={plan.code}>
                <div className="flex items-start justify-between gap-3">
                  <p className="text-lg font-semibold text-text-primary">{plan.name}</p>
                  {action.kind === 'current' && <Badge tone="success">Your plan</Badge>}
                </div>
                {plan.description && (
                  <p className="mt-1 text-[0.9375rem] text-text-muted">{plan.description}</p>
                )}
                <div className="mt-3 space-y-1 text-[0.9375rem] tabular-nums text-text-primary">
                  {plan.code === 'FREE' ? (
                    <p>{money(0, plan.prices[0]?.currency ?? 'USD')}</p>
                  ) : plan.prices.length > 0 ? (
                    plan.prices.map((p) => <p key={p.id}>{priceLabel(p)}</p>)
                  ) : (
                    <p className="text-text-muted">No price in your country yet.</p>
                  )}
                </div>
                <ul className="mt-3 space-y-1.5">
                  {planFeatureLines(plan).map((line) => (
                    <li key={line} className="flex items-start gap-2 text-sm text-text-secondary">
                      <CheckCircle2
                        className="mt-0.5 h-4 w-4 shrink-0 text-status-success"
                        aria-hidden
                      />
                      {line}
                    </li>
                  ))}
                </ul>
                {action.kind === 'ask' && (
                  <Button
                    variant="outline"
                    size="sm"
                    className="mt-4"
                    onClick={() => setAsking(plan)}
                  >
                    {action.label}
                  </Button>
                )}
                {action.kind === 'checkout' && (
                  <div className="mt-4 flex flex-wrap gap-2">
                    {plan.prices.map((p) => (
                      <Button
                        key={p.id}
                        size="sm"
                        loading={paying === p.id}
                        onClick={() => void checkout(p.id)}
                      >
                        <CreditCard className="h-4 w-4" aria-hidden />
                        {action.label} ({p.interval === 'YEAR' ? 'yearly' : 'monthly'})
                      </Button>
                    ))}
                  </div>
                )}
              </Card>
            );
          })}
        </div>
      </section>

      {packs.length > 0 && (
        <section aria-labelledby="credit-packs" className="space-y-3">
          <h2 id="credit-packs" className="font-semibold text-text-primary">
            Extra campaign email credits
          </h2>
          <p className="text-[0.9375rem] text-text-muted">
            Credits are used after your monthly emails run out. They do not expire.
          </p>
          <div className="grid gap-4 md:grid-cols-2">
            {packs.map((pack) => (
              <Card key={pack.code}>
                <p className="font-semibold text-text-primary">{pack.name}</p>
                <p className="mt-1 tabular-nums text-text-primary">
                  {money(pack.amountMinor, pack.currency)}
                </p>
                <Button
                  size="sm"
                  className="mt-3"
                  loading={paying === pack.code}
                  onClick={() => void buyCredits(pack.code)}
                >
                  Buy credits
                </Button>
              </Card>
            ))}
          </div>
        </section>
      )}

      <section aria-labelledby="invoices" className="space-y-3">
        <h2 id="invoices" className="font-semibold text-text-primary">
          Invoices
        </h2>
        {invoices.isError ? (
          <ErrorState
            message={errorMessage(invoices.error)}
            onRetry={() => void invoices.refetch()}
          />
        ) : invoices.isLoading ? (
          <Skeleton className="h-24" />
        ) : (invoices.data ?? []).length === 0 ? (
          <EmptyState icon={ReceiptText} title="No invoices" hint={NO_INVOICES} compact />
        ) : (
          <Card>
            <ul className="divide-y divide-border">
              {(invoices.data ?? []).map((inv) => (
                <li key={inv.id} className="flex flex-wrap items-center justify-between gap-2 py-2">
                  <span className="font-medium tabular-nums">{inv.number}</span>
                  <span className="text-sm text-text-muted">{dateOnly(inv.issuedAt)}</span>
                  <span className="tabular-nums">{money(inv.totalMinor, inv.currency)}</span>
                  <Badge tone={inv.status === 'PAID' ? 'success' : undefined}>{inv.status}</Badge>
                  <Button variant="outline" size="sm" onClick={() => void viewInvoice(inv.id)}>
                    View
                  </Button>
                </li>
              ))}
            </ul>
          </Card>
        )}
      </section>

      <Dialog
        open={cancelOpen}
        onClose={() => setCancelOpen(false)}
        title="Cancel your plan?"
        footer={
          <>
            <Button variant="outline" onClick={() => setCancelOpen(false)} disabled={cancelling}>
              Keep my plan
            </Button>
            <Button loading={cancelling} onClick={() => void cancelPlan()}>
              Cancel plan
            </Button>
          </>
        }
      >
        <p className="text-sm text-text-secondary">{CANCEL_DIALOG_TEXT}</p>
      </Dialog>

      <Dialog
        open={asking !== null}
        onClose={() => setAsking(null)}
        title={asking ? `Ask about ${asking.name}` : 'Ask about a plan'}
        footer={
          <>
            <Button variant="outline" onClick={() => setAsking(null)} disabled={sending}>
              Cancel
            </Button>
            <Button loading={sending} onClick={() => void send()}>
              Send to support
            </Button>
          </>
        }
      >
        <p className="text-sm text-text-secondary">{ASK_DIALOG_TEXT}</p>
        <p className="mt-2 text-sm text-text-secondary">
          We will reply about <strong>{activeOrgSentenceName}</strong>.
        </p>
        <div className="mt-3">
          <Textarea
            rows={4}
            aria-label="What do you want to do?"
            placeholder="What do you want to do?"
            value={note}
            onChange={(e) => setNote(e.target.value)}
          />
        </div>
      </Dialog>
    </div>
  );
}
