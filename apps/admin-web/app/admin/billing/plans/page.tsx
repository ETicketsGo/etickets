'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Plus } from 'lucide-react';
import { ALL_ENTITLEMENT_KEYS, ENTITLEMENT_DEFINITIONS } from '@eticketsgo/shared-types';
import {
  api,
  Badge,
  Button,
  Card,
  Dialog,
  EmptyState,
  ErrorState,
  Input,
  PageHeader,
  Select,
  Skeleton,
  Textarea,
  errorMessage,
  money,
  useToast,
  type AdminBillingPlan,
  type AdminBillingPrice,
} from '@eticketsgo/web-kit';
import { useHolds } from '@/lib/capabilities';
import { CreditPackPrices } from './credit-pack-prices';
import {
  BILLING_COPY,
  INTERVAL_WORDS,
  entitlementLabel,
  entitlementValueText,
  majorToMinor,
  minorToMajorInput,
  wholeNumber,
} from '@/lib/billing';

const KEY = ['admin', 'billing', 'plans'];

/**
 * Plans & prices: the catalogue organizers would buy from.
 *
 * Everyone with BILLING_READ sees it. Only a BILLING_MANAGE holder sees the controls that
 * change it; the API refuses the others anyway. Prices are provisional until the owner
 * confirms them, and the page says so first.
 */
export default function BillingPlansPage() {
  const mayManage = useHolds('BILLING_MANAGE');
  const qc = useQueryClient();
  const toast = useToast();
  const plans = useQuery({ queryKey: KEY, queryFn: () => api.admin.billing.plans() });

  const [loading, setLoading] = useState(false);
  const [editingPlan, setEditingPlan] = useState<AdminBillingPlan | null>(null);
  const [editingEntitlements, setEditingEntitlements] = useState<AdminBillingPlan | null>(null);
  const [addingPriceTo, setAddingPriceTo] = useState<AdminBillingPlan | null>(null);
  const [editingPrice, setEditingPrice] = useState<AdminBillingPrice | null>(null);
  const [deactivating, setDeactivating] = useState<AdminBillingPrice | null>(null);

  const refresh = () => qc.invalidateQueries({ queryKey: ['admin', 'billing'] });
  const failed = (e: unknown) => toast.push(errorMessage(e), 'error');

  const load = useMutation({
    mutationFn: () => api.admin.billing.loadProvisional(),
    onSuccess: (r) => {
      setLoading(false);
      refresh();
      toast.push(
        `Catalogue loaded. New plans: ${r.plansCreated}. New prices: ${r.pricesCreated}.`,
        'success',
      );
    },
    onError: failed,
  });

  const deactivate = useMutation({
    mutationFn: (id: string) => api.admin.billing.deactivatePrice(id),
    onSuccess: () => {
      setDeactivating(null);
      refresh();
      toast.push('Price switched off.', 'success');
    },
    onError: failed,
  });

  const list = plans.data ?? [];

  return (
    <div className="space-y-6">
      <PageHeader
        title="Plans & prices"
        description="The plans organizers can be on, what each one includes, and what it costs."
        action={
          mayManage ? (
            <Button variant="outline" onClick={() => setLoading(true)}>
              Load provisional catalogue
            </Button>
          ) : undefined
        }
      />

      <p
        role="note"
        className="rounded-md border border-status-warning/40 bg-tint-warning p-3 text-sm text-text-primary"
      >
        {BILLING_COPY.provisional}
      </p>
      {!mayManage && <p className="text-sm text-text-secondary">{BILLING_COPY.readOnly}</p>}

      {plans.isError ? (
        <ErrorState message="We could not load the plans." onRetry={() => plans.refetch()} />
      ) : plans.isLoading ? (
        <div className="space-y-3">
          <Skeleton className="h-40" />
          <Skeleton className="h-40" />
        </div>
      ) : list.length === 0 ? (
        <EmptyState
          title="No plans yet"
          hint={BILLING_COPY.noCatalog}
          action={
            mayManage ? (
              <Button onClick={() => setLoading(true)}>Load provisional catalogue</Button>
            ) : undefined
          }
        />
      ) : (
        list.map((plan) => (
          <Card
            key={plan.id}
            title={
              <span className="flex flex-wrap items-center gap-2">
                {plan.name}
                <span className="text-caption font-normal text-text-muted">{plan.code}</span>
                {plan.active ? (
                  <Badge tone="success">Active</Badge>
                ) : (
                  <Badge tone="neutral">Off</Badge>
                )}
              </span>
            }
            action={
              mayManage ? (
                <div className="flex flex-wrap gap-2">
                  <Button size="sm" variant="outline" onClick={() => setEditingPlan(plan)}>
                    Edit plan
                  </Button>
                  <Button size="sm" variant="outline" onClick={() => setEditingEntitlements(plan)}>
                    Edit features
                  </Button>
                </div>
              ) : undefined
            }
          >
            {plan.description && (
              <p className="mb-4 text-sm text-text-secondary">{plan.description}</p>
            )}
            <div className="grid gap-6 lg:grid-cols-2">
              <div>
                <h3 className="mb-2 text-sm font-semibold text-text-primary">What it includes</h3>
                {plan.entitlements.length === 0 ? (
                  <p className="text-sm text-text-secondary">Nothing beyond the basics.</p>
                ) : (
                  <ul className="divide-y divide-border text-sm">
                    {plan.entitlements.map((e) => (
                      <li key={e.id} className="flex justify-between gap-3 py-1.5">
                        <span>{entitlementLabel(e.key)}</span>
                        <span className="tabular-nums text-text-secondary">
                          {entitlementValueText(e)}
                        </span>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
              <div>
                <div className="mb-2 flex items-center justify-between gap-2">
                  <h3 className="text-sm font-semibold text-text-primary">Prices</h3>
                  {mayManage && (
                    <Button
                      size="sm"
                      variant="ghost"
                      icon={Plus}
                      onClick={() => setAddingPriceTo(plan)}
                    >
                      Add price
                    </Button>
                  )}
                </div>
                {plan.prices.length === 0 ? (
                  <p className="text-sm text-text-secondary">No prices set.</p>
                ) : (
                  <div className="overflow-x-auto">
                    <table className="w-full text-sm">
                      <thead>
                        <tr className="text-left text-text-secondary">
                          <th className="py-1 pr-2 font-medium">Country</th>
                          <th className="py-1 pr-2 font-medium">Billed</th>
                          <th className="py-1 pr-2 text-right font-medium">Amount</th>
                          <th className="py-1 pr-2 font-medium">Trial</th>
                          <th className="py-1 pr-2 font-medium">State</th>
                          {mayManage && <th className="py-1 font-medium" />}
                        </tr>
                      </thead>
                      <tbody>
                        {plan.prices.map((p) => (
                          <tr key={p.id} className="border-t border-border">
                            <td className="py-1.5 pr-2">
                              {p.country} ({p.currency})
                            </td>
                            <td className="py-1.5 pr-2">{INTERVAL_WORDS[p.interval]}</td>
                            <td className="py-1.5 pr-2 text-right tabular-nums">
                              {money(p.amountMinor, p.currency)}
                            </td>
                            <td className="py-1.5 pr-2">
                              {p.trialDays ? `${p.trialDays} days` : 'None'}
                            </td>
                            <td className="py-1.5 pr-2">
                              {p.active ? (
                                <Badge tone="success">Active</Badge>
                              ) : (
                                <Badge tone="neutral">Off</Badge>
                              )}
                            </td>
                            {mayManage && (
                              <td className="py-1.5 text-right">
                                {p.active && (
                                  <span className="inline-flex gap-1">
                                    <Button
                                      size="sm"
                                      variant="ghost"
                                      onClick={() => setEditingPrice(p)}
                                    >
                                      Edit
                                    </Button>
                                    <Button
                                      size="sm"
                                      variant="ghost"
                                      onClick={() => setDeactivating(p)}
                                    >
                                      Switch off
                                    </Button>
                                  </span>
                                )}
                              </td>
                            )}
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </div>
            </div>
          </Card>
        ))
      )}

      <CreditPackPrices mayManage={mayManage} />

      {mayManage && (
        <>
          <Dialog
            open={loading}
            onClose={() => setLoading(false)}
            title="Load provisional catalogue"
            footer={
              <>
                <Button variant="outline" onClick={() => setLoading(false)}>
                  Cancel
                </Button>
                <Button loading={load.isPending} onClick={() => load.mutate()}>
                  Load
                </Button>
              </>
            }
          >
            <p className="text-sm text-text-secondary">{BILLING_COPY.loadExplains}</p>
          </Dialog>

          <PlanDialog plan={editingPlan} onClose={() => setEditingPlan(null)} onSaved={refresh} />
          <EntitlementsDialog
            plan={editingEntitlements}
            onClose={() => setEditingEntitlements(null)}
            onSaved={refresh}
          />
          <NewPriceDialog
            plan={addingPriceTo}
            onClose={() => setAddingPriceTo(null)}
            onSaved={refresh}
          />
          <EditPriceDialog
            price={editingPrice}
            onClose={() => setEditingPrice(null)}
            onSaved={refresh}
          />

          <Dialog
            open={!!deactivating}
            onClose={() => setDeactivating(null)}
            title="Switch off this price"
            footer={
              <>
                <Button variant="outline" onClick={() => setDeactivating(null)}>
                  Cancel
                </Button>
                <Button
                  variant="danger"
                  loading={deactivate.isPending}
                  onClick={() => deactivating && deactivate.mutate(deactivating.id)}
                >
                  Switch off
                </Button>
              </>
            }
          >
            {deactivating && (
              <p className="text-sm text-text-secondary">
                Switch off the {INTERVAL_WORDS[deactivating.interval].toLowerCase()} price of{' '}
                {money(deactivating.amountMinor, deactivating.currency)} in {deactivating.country}?
                Nobody can choose it after this. It stays on file.
              </p>
            )}
          </Dialog>
        </>
      )}
    </div>
  );
}

function PlanDialog({
  plan,
  onClose,
  onSaved,
}: {
  plan: AdminBillingPlan | null;
  onClose: () => void;
  onSaved: () => void;
}) {
  const toast = useToast();
  // Keyed by plan id so each open starts from the plan as it is now.
  const [draft, setDraft] = useState<{
    id: string;
    name: string;
    description: string;
    active: boolean;
  } | null>(null);
  const current =
    plan && draft?.id === plan.id
      ? draft
      : plan
        ? { id: plan.id, name: plan.name, description: plan.description ?? '', active: plan.active }
        : null;

  const save = useMutation({
    mutationFn: () =>
      api.admin.billing.updatePlan(current!.id, {
        name: current!.name.trim(),
        description: current!.description.trim() || null,
        active: current!.active,
      }),
    onSuccess: () => {
      toast.push('Plan saved.', 'success');
      setDraft(null);
      onSaved();
      onClose();
    },
    onError: (e) => toast.push(errorMessage(e), 'error'),
  });

  const close = () => {
    setDraft(null);
    onClose();
  };

  return (
    <Dialog
      open={!!plan}
      onClose={close}
      title={`Edit plan ${plan?.name ?? ''}`}
      footer={
        <>
          <Button variant="outline" onClick={close}>
            Cancel
          </Button>
          <Button
            loading={save.isPending}
            disabled={!current?.name.trim()}
            onClick={() => save.mutate()}
          >
            Save
          </Button>
        </>
      }
    >
      {current && (
        <div className="space-y-3">
          <Input
            label="Name"
            maxLength={60}
            value={current.name}
            onChange={(e) => setDraft({ ...current, name: e.target.value })}
          />
          <Textarea
            label="Description"
            rows={3}
            maxLength={300}
            value={current.description}
            onChange={(e) => setDraft({ ...current, description: e.target.value })}
          />
          <label className="flex items-center gap-2 text-sm text-text-secondary">
            <input
              type="checkbox"
              checked={current.active}
              onChange={(e) => setDraft({ ...current, active: e.target.checked })}
            />
            Active. Organizers can see this plan.
          </label>
        </div>
      )}
    </Dialog>
  );
}

type EntitlementDraft = Record<string, { on: boolean; amount: string }>;

function draftFor(plan: AdminBillingPlan): EntitlementDraft {
  const out: EntitlementDraft = {};
  for (const key of ALL_ENTITLEMENT_KEYS) {
    const row = plan.entitlements.find((e) => e.key === key);
    out[key] = {
      on: row?.boolValue === true,
      amount: row?.intValue != null ? String(row.intValue) : '',
    };
  }
  return out;
}

function EntitlementsDialog({
  plan,
  onClose,
  onSaved,
}: {
  plan: AdminBillingPlan | null;
  onClose: () => void;
  onSaved: () => void;
}) {
  const toast = useToast();
  const [state, setState] = useState<{ id: string; values: EntitlementDraft } | null>(null);
  const values = plan ? (state?.id === plan.id ? state.values : draftFor(plan)) : null;
  const set = (key: string, patch: Partial<{ on: boolean; amount: string }>) => {
    if (!plan || !values) return;
    setState({ id: plan.id, values: { ...values, [key]: { ...values[key], ...patch } } });
  };

  const badNumber =
    !!values &&
    ALL_ENTITLEMENT_KEYS.some(
      (k) =>
        ENTITLEMENT_DEFINITIONS[k].kind === 'int' &&
        values[k].amount.trim() !== '' &&
        wholeNumber(values[k].amount) == null,
    );

  const save = useMutation({
    mutationFn: () => {
      const body: { key: string; boolValue?: boolean; intValue?: number }[] = [];
      for (const key of ALL_ENTITLEMENT_KEYS) {
        const v = values![key];
        if (ENTITLEMENT_DEFINITIONS[key].kind === 'int') {
          const n = wholeNumber(v.amount);
          if (n != null) body.push({ key, intValue: n });
        } else if (v.on) {
          body.push({ key, boolValue: true });
        }
      }
      return api.admin.billing.setPlanEntitlements(plan!.id, body);
    },
    onSuccess: () => {
      toast.push('Features saved.', 'success');
      setState(null);
      onSaved();
      onClose();
    },
    onError: (e) => toast.push(errorMessage(e), 'error'),
  });

  const close = () => {
    setState(null);
    onClose();
  };

  return (
    <Dialog
      open={!!plan}
      onClose={close}
      title={`Features in ${plan?.name ?? ''}`}
      description="This replaces the plan's whole feature list. It changes what every organization on the plan can use."
      size="lg"
      footer={
        <>
          <Button variant="outline" onClick={close}>
            Cancel
          </Button>
          <Button loading={save.isPending} disabled={badNumber} onClick={() => save.mutate()}>
            Save features
          </Button>
        </>
      }
    >
      {values && (
        <ul className="space-y-3">
          {ALL_ENTITLEMENT_KEYS.map((key) => {
            const def = ENTITLEMENT_DEFINITIONS[key];
            return (
              <li key={key}>
                {def.kind === 'int' ? (
                  <Input
                    label={def.label}
                    inputMode="numeric"
                    value={values[key].amount}
                    hint={`${def.description} Leave empty for none.`}
                    error={
                      values[key].amount.trim() !== '' && wholeNumber(values[key].amount) == null
                        ? 'A whole number.'
                        : undefined
                    }
                    onChange={(e) => set(key, { amount: e.target.value })}
                  />
                ) : (
                  <label className="flex items-start gap-2 text-sm">
                    <input
                      type="checkbox"
                      className="mt-1"
                      checked={values[key].on}
                      onChange={(e) => set(key, { on: e.target.checked })}
                    />
                    <span>
                      <span className="font-medium text-text-primary">{def.label}</span>
                      <span className="block text-caption text-text-muted">{def.description}</span>
                    </span>
                  </label>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </Dialog>
  );
}

function NewPriceDialog({
  plan,
  onClose,
  onSaved,
}: {
  plan: AdminBillingPlan | null;
  onClose: () => void;
  onSaved: () => void;
}) {
  const toast = useToast();
  const blank = {
    country: '',
    currency: '',
    interval: 'MONTH' as 'MONTH' | 'YEAR',
    amount: '',
    trial: '',
  };
  const [f, setF] = useState(blank);
  const [tried, setTried] = useState(false);

  const country = f.country.trim().toUpperCase();
  const currency = f.currency.trim().toUpperCase();
  const countryOk = /^[A-Z]{2}$/.test(country);
  const currencyOk = /^[A-Z]{3}$/.test(currency);
  const amountMinor = currencyOk ? majorToMinor(f.amount, currency) : null;
  const trialDays = f.trial.trim() === '' ? null : wholeNumber(f.trial);
  const trialOk = f.trial.trim() === '' || (trialDays != null && trialDays <= 365);
  const ok = countryOk && currencyOk && amountMinor != null && trialOk;

  const close = () => {
    setF(blank);
    setTried(false);
    onClose();
  };

  const save = useMutation({
    mutationFn: () =>
      api.admin.billing.createPrice({
        planId: plan!.id,
        country,
        currency,
        interval: f.interval,
        amountMinor: amountMinor!,
        trialDays,
      }),
    onSuccess: () => {
      toast.push('Price added.', 'success');
      onSaved();
      close();
    },
    onError: (e) => toast.push(errorMessage(e), 'error'),
  });

  return (
    <Dialog
      open={!!plan}
      onClose={close}
      title={`Add a price to ${plan?.name ?? ''}`}
      footer={
        <>
          <Button variant="outline" onClick={close}>
            Cancel
          </Button>
          <Button
            loading={save.isPending}
            onClick={() => {
              setTried(true);
              if (ok) save.mutate();
            }}
          >
            Add price
          </Button>
        </>
      }
    >
      <div className="grid gap-3 sm:grid-cols-2">
        <Input
          label="Country"
          maxLength={2}
          placeholder="IN"
          value={f.country}
          hint="Two letters, for example IN or US."
          error={tried && !countryOk ? 'Two letters.' : undefined}
          onChange={(e) => setF({ ...f, country: e.target.value })}
        />
        <Input
          label="Currency"
          maxLength={3}
          placeholder="INR"
          value={f.currency}
          hint="Three letters, for example INR or USD."
          error={tried && !currencyOk ? 'Three letters.' : undefined}
          onChange={(e) => setF({ ...f, currency: e.target.value })}
        />
        <Select
          label="Billed"
          value={f.interval}
          onChange={(e) => setF({ ...f, interval: e.target.value as 'MONTH' | 'YEAR' })}
        >
          <option value="MONTH">Monthly</option>
          <option value="YEAR">Yearly</option>
        </Select>
        <Input
          label="Amount"
          inputMode="decimal"
          placeholder="999"
          value={f.amount}
          hint={
            amountMinor != null && currencyOk
              ? `Saved as ${money(amountMinor, currency)}.`
              : 'In rupees or dollars, not paise or cents.'
          }
          error={
            tried && amountMinor == null ? 'A plain amount, for example 999 or 19.50.' : undefined
          }
          onChange={(e) => setF({ ...f, amount: e.target.value })}
        />
        <Input
          label="Trial days"
          inputMode="numeric"
          value={f.trial}
          hint="Optional. Leave empty for no trial."
          error={tried && !trialOk ? 'A whole number up to 365.' : undefined}
          onChange={(e) => setF({ ...f, trial: e.target.value })}
        />
      </div>
    </Dialog>
  );
}

function EditPriceDialog({
  price,
  onClose,
  onSaved,
}: {
  price: AdminBillingPrice | null;
  onClose: () => void;
  onSaved: () => void;
}) {
  const toast = useToast();
  const [draft, setDraft] = useState<{ id: string; amount: string; trial: string } | null>(null);
  const current =
    price && draft?.id === price.id
      ? draft
      : price
        ? {
            id: price.id,
            amount: minorToMajorInput(price.amountMinor, price.currency),
            trial: price.trialDays != null ? String(price.trialDays) : '',
          }
        : null;
  const amountMinor = current && price ? majorToMinor(current.amount, price.currency) : null;
  const trialDays = !current || current.trial.trim() === '' ? null : wholeNumber(current.trial);
  const trialOk =
    !current || current.trial.trim() === '' || (trialDays != null && trialDays <= 365);

  const close = () => {
    setDraft(null);
    onClose();
  };

  const save = useMutation({
    mutationFn: () =>
      api.admin.billing.updatePrice(price!.id, { amountMinor: amountMinor!, trialDays }),
    onSuccess: () => {
      toast.push('Price saved.', 'success');
      onSaved();
      close();
    },
    onError: (e) => toast.push(errorMessage(e), 'error'),
  });

  return (
    <Dialog
      open={!!price}
      onClose={close}
      title="Edit price"
      description={
        price
          ? `${INTERVAL_WORDS[price.interval]} price in ${price.country} (${price.currency}).`
          : undefined
      }
      footer={
        <>
          <Button variant="outline" onClick={close}>
            Cancel
          </Button>
          <Button
            loading={save.isPending}
            disabled={amountMinor == null || !trialOk}
            onClick={() => save.mutate()}
          >
            Save
          </Button>
        </>
      }
    >
      {current && price && (
        <div className="grid gap-3 sm:grid-cols-2">
          <Input
            label="Amount"
            inputMode="decimal"
            value={current.amount}
            hint={
              amountMinor != null
                ? `Saved as ${money(amountMinor, price.currency)}.`
                : 'In rupees or dollars, not paise or cents.'
            }
            error={amountMinor == null ? 'A plain amount, for example 999 or 19.50.' : undefined}
            onChange={(e) => setDraft({ ...current, amount: e.target.value })}
          />
          <Input
            label="Trial days"
            inputMode="numeric"
            value={current.trial}
            hint="Leave empty for no trial."
            error={!trialOk ? 'A whole number up to 365.' : undefined}
            onChange={(e) => setDraft({ ...current, trial: e.target.value })}
          />
        </div>
      )}
    </Dialog>
  );
}
