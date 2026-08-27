'use client';

import { useMutation, useQuery } from '@tanstack/react-query';
import { Wallet } from 'lucide-react';
import { useToast } from '@eticketsgo/web-kit';
import { api } from '@/lib/api';

const LABEL: Record<string, string> = { apple: 'Apple Wallet', google: 'Google Wallet' };

/**
 * Wallet-pass actions — shown ONLY for an eligible (ACTIVE) ticket and ONLY for a
 * provider that is safely configured (sandbox or production). When no provider is
 * configured, nothing renders and the existing ticket UI is unchanged. A pass is a
 * projection of this ticket (same signed QR) — it is never a separate ticket, and no
 * credential material is ever sent to the browser.
 */
export function WalletPasses({
  ticketId,
  ticketStatus,
}: {
  ticketId: string;
  ticketStatus: string;
}) {
  const toast = useToast();
  const eligible = ticketStatus === 'ACTIVE';

  const providers = useQuery({
    queryKey: ['wallet-providers'],
    queryFn: () => api.walletProviders(),
    enabled: eligible,
    retry: false,
  });

  const generate = useMutation({
    mutationFn: (provider: 'apple' | 'google') => api.generateWalletPass(ticketId, provider),
    onSuccess: (res) => {
      if (!res.available) {
        toast.push(res.reason, 'warning');
        return;
      }
      if (!res.eligible) {
        toast.push(res.reason, 'warning');
        return;
      }
      // Sandbox: offer the non-secret pass descriptor as a downloadable diagnostic so
      // the flow is exercised end-to-end without production signing material.
      const blob = new Blob([JSON.stringify(res.descriptor, null, 2)], {
        type: 'application/json',
      });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `${res.provider}-pass-${ticketId.slice(0, 8)}.json`;
      a.click();
      URL.revokeObjectURL(url);
      toast.push(
        res.status === 'sandbox'
          ? `${LABEL[res.provider]} sandbox pass created (descriptor downloaded).`
          : `${LABEL[res.provider]} pass created.`,
        'success',
      );
    },
    onError: () => toast.push('Could not create the wallet pass.', 'error'),
  });

  if (!eligible) return null;
  const usable = (providers.data?.providers ?? []).filter((p) => p.status !== 'unavailable');
  if (providers.isLoading || usable.length === 0) return null;

  return (
    <section
      aria-label="Wallet passes"
      className="rounded-lg border border-border bg-background-surface p-4 shadow-sm"
    >
      <h2 className="mb-1 flex items-center gap-2 text-title font-semibold text-text-primary">
        <Wallet className="h-4 w-4" aria-hidden /> Add to your wallet
      </h2>
      <p className="mb-3 text-caption text-text-muted">
        A wallet pass is a shortcut to this ticket — it uses the same secure QR code.
      </p>
      <div className="flex flex-wrap gap-2">
        {usable.map((p) => (
          <button
            key={p.provider}
            data-testid={`wallet-btn-${p.provider}`}
            disabled={generate.isPending}
            onClick={() => generate.mutate(p.provider)}
            className="inline-flex items-center gap-2 rounded-md border border-border bg-background-subtle px-4 py-2.5 text-[0.9375rem] font-medium text-text-primary transition-colors hover:bg-background-surface focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50 disabled:opacity-60"
          >
            <Wallet className="h-4 w-4" aria-hidden />
            Add to {LABEL[p.provider]}
            {p.mode === 'sandbox' && (
              <span className="rounded bg-tint-warning px-1.5 py-0.5 text-xs font-normal text-status-warning">
                sandbox
              </span>
            )}
          </button>
        ))}
      </div>
    </section>
  );
}
