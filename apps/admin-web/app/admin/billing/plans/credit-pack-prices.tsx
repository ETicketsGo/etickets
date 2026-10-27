'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import {
  api,
  Badge,
  Button,
  Card,
  Dialog,
  ErrorState,
  Input,
  Skeleton,
  errorMessage,
  money,
  useToast,
  type AdminCreditPack,
  type AdminCreditPackPrice,
} from '@eticketsgo/web-kit';
import { majorToMinor, minorToMajorInput } from '@/lib/billing';

const KEY = ['admin', 'billing', 'credit-packs'];

/** Plain words for the section. ASCII only, per house rule. */
export const CREDIT_PACK_COPY = {
  title: 'Email credit packs',
  explains:
    'Packs of 1,000, 5,000 and 10,000 campaign email credits. A pack is on sale in a country only after you set its price and publish it. Prices are before tax.',
  notOnSale: 'Not on sale',
  onSale: 'On sale',
  noPrice: 'No price',
} as const;

interface Editing {
  pack: AdminCreditPack;
  price: AdminCreditPackPrice;
}

/**
 * Credit pack prices per country (owner decision 2026-10-27): unpublished until somebody with
 * BILLING_MANAGE sets a price and publishes it. Readers see the table; the controls are shown
 * only to BILLING_MANAGE holders, and the API refuses the others anyway (with a fresh second
 * factor for every write).
 */
export function CreditPackPrices({ mayManage }: { mayManage: boolean }) {
  const qc = useQueryClient();
  const toast = useToast();
  const packs = useQuery({ queryKey: KEY, queryFn: () => api.admin.billing.creditPacks() });
  const [editing, setEditing] = useState<Editing | null>(null);
  const [amount, setAmount] = useState('');

  const refresh = () => qc.invalidateQueries({ queryKey: KEY });
  const failed = (e: unknown) => toast.push(errorMessage(e), 'error');

  const save = useMutation({
    mutationFn: (e: Editing & { amountMinor: number }) =>
      api.admin.billing.setCreditPackPrice(e.pack.code, e.price.country, {
        currency: e.price.currency ?? '',
        amountMinor: e.amountMinor,
        expectedVersion: e.price.version,
      }),
    onSuccess: () => {
      setEditing(null);
      void refresh();
      toast.push('Price saved. It is not on sale until you publish it.', 'success');
    },
    onError: failed,
  });

  const publish = useMutation({
    mutationFn: (e: Editing & { on: boolean }) =>
      e.on
        ? api.admin.billing.publishCreditPack(e.pack.code, e.price.country, e.price.version)
        : api.admin.billing.unpublishCreditPack(e.pack.code, e.price.country, e.price.version),
    onSuccess: (_r, e) => {
      void refresh();
      toast.push(e.on ? 'Pack published.' : 'Pack taken off sale.', 'success');
    },
    onError: failed,
  });

  const parsed = editing ? majorToMinor(amount, editing.price.currency ?? 'USD') : null;

  return (
    <Card title={CREDIT_PACK_COPY.title}>
      <p className="mb-4 text-sm text-text-secondary">{CREDIT_PACK_COPY.explains}</p>
      {packs.isError ? (
        <ErrorState message="We could not load the credit packs." onRetry={() => packs.refetch()} />
      ) : packs.isLoading ? (
        <Skeleton className="h-32" />
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-text-secondary">
                <th className="py-1 pr-2 font-medium">Pack</th>
                <th className="py-1 pr-2 font-medium">Country</th>
                <th className="py-1 pr-2 text-right font-medium">Price before tax</th>
                <th className="py-1 pr-2 font-medium">State</th>
                {mayManage && <th className="py-1 font-medium" />}
              </tr>
            </thead>
            <tbody>
              {(packs.data ?? []).flatMap((pack) =>
                pack.prices.map((price) => (
                  <tr key={`${pack.code}-${price.country}`} className="border-t border-border">
                    <td className="py-1.5 pr-2">{pack.name}</td>
                    <td className="py-1.5 pr-2">
                      {price.country} ({price.currency})
                    </td>
                    <td className="py-1.5 pr-2 text-right tabular-nums">
                      {price.amountMinor != null && price.currency
                        ? money(price.amountMinor, price.currency)
                        : CREDIT_PACK_COPY.noPrice}
                    </td>
                    <td className="py-1.5 pr-2">
                      {price.published ? (
                        <Badge tone="success">{CREDIT_PACK_COPY.onSale}</Badge>
                      ) : (
                        <Badge tone="neutral">{CREDIT_PACK_COPY.notOnSale}</Badge>
                      )}
                    </td>
                    {mayManage && (
                      <td className="py-1.5 text-right">
                        <span className="inline-flex gap-1">
                          <Button
                            size="sm"
                            variant="ghost"
                            onClick={() => {
                              setAmount(
                                price.amountMinor != null
                                  ? minorToMajorInput(price.amountMinor, price.currency ?? 'USD')
                                  : '',
                              );
                              setEditing({ pack, price });
                            }}
                          >
                            Set price
                          </Button>
                          {price.amountMinor != null && (
                            <Button
                              size="sm"
                              variant="ghost"
                              loading={publish.isPending}
                              onClick={() => publish.mutate({ pack, price, on: !price.published })}
                            >
                              {price.published ? 'Unpublish' : 'Publish'}
                            </Button>
                          )}
                        </span>
                      </td>
                    )}
                  </tr>
                )),
              )}
            </tbody>
          </table>
        </div>
      )}

      {mayManage && editing && (
        <Dialog
          open
          onClose={() => setEditing(null)}
          title={`${editing.pack.name}, ${editing.price.country}`}
          footer={
            <>
              <Button variant="outline" onClick={() => setEditing(null)}>
                Cancel
              </Button>
              <Button
                disabled={parsed == null || parsed <= 0}
                loading={save.isPending}
                onClick={() => parsed != null && save.mutate({ ...editing, amountMinor: parsed })}
              >
                Save price
              </Button>
            </>
          }
        >
          <div className="space-y-4">
            <Input
              label={`Price before tax (${editing.price.currency})`}
              inputMode="decimal"
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
            />
            <p className="text-sm text-text-secondary">
              Saving a price does not put the pack on sale. Publish it when you are ready.
            </p>
          </div>
        </Dialog>
      )}
    </Card>
  );
}
