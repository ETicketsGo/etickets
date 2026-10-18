'use client';

import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { api } from '@/lib/api';
import { useFormat } from '@/lib/format';
import { useToast } from '@/components/ui';
import { BrandButton } from '@eticketsgo/web-kit';
import { ACCOUNT_PANEL, AccountHeading, AccountPage, BrandError } from '@/components/account-brand';
import { Placeholder } from '@/components/home/parts';
import { BrandEmpty } from '@/components/storefront-brand';
import { SignInRequired, isAuthFailure, useSignedIn } from '@/components/sign-in-required';

/**
 * Every receipt, invoice and credit note this account has been issued.
 *
 * ── WHY THIS PAGE EXISTS ───────────────────────────────────────────────────────────
 * A document could be fetched for a BOOKING whose id you already had, or listed for an
 * ORGANIZATION you were a member of. A customer has neither to hand. So somebody who closed
 * the confirmation page without saving their receipt had no route back to it — the platform
 * had issued them a financial document and given them nowhere to find it.
 *
 * People need these after the fact and for unglamorous reasons: an expense claim weeks later,
 * a reimbursement, an accountant asking in April. "Find the email" is not an answer when the
 * email is the thing that was lost.
 *
 * On the brand layer (docs/design/DESIGN-SYSTEM.md): each document is a flat white panel on
 * paper with its amount in tabular figures and a hairline Open button. Same list, same words.
 */
const KIND_LABEL: Record<string, string> = {
  RECEIPT: 'Receipt',
  INVOICE: 'Invoice',
  CREDIT_NOTE: 'Credit note',
};

export default function ReceiptsPage() {
  const { dateOnly, money } = useFormat();
  const toast = useToast();
  const [opening, setOpening] = useState<string | null>(null);

  const signedIn = useSignedIn();
  const { data, isLoading, isError, error, refetch } = useQuery({
    queryKey: ['receipts', 'mine'],
    queryFn: () => api.myReceipts({ pageSize: 50 }),
  });

  /*
    Opened through the authenticated fetch rather than as a link.

    A plain href sends no Authorization header — the token lives in localStorage, not a
    cookie — so the tab would open on a 401. That was reported once already from QA; this is
    the same helper the booking page uses.
  */
  const open = async (id: string) => {
    setOpening(id);
    try {
      await api.openReceiptHtml(id);
    } catch {
      toast.push('We could not open that document. Please try again.', 'error');
    } finally {
      setOpening(null);
    }
  };

  /*
    `items`, not `data`. The client's type said `Paged` and the endpoint has always returned
    `{ items, total, page, pageSize }` - so this read undefined and the page told every buyer
    "No receipts yet", including the ones holding receipts. This page exists precisely so that
    somebody who closed the confirmation screen has a route back to their receipt, and it was
    the one route that could never work.
  */
  const rows = data?.items ?? [];

  return (
    <AccountPage>
      <AccountHeading
        title="Receipts"
        lead="Every receipt and invoice for your bookings. Open one to print it or save it as a PDF."
      />

      {signedIn === false || isAuthFailure(error) ? (
        /* Same correction as the notification settings: no session is not a broken page. */
        <SignInRequired
          title="Sign in to see your receipts"
          description="Your receipts and invoices are part of your ETicketsGo account."
        />
      ) : isError ? (
        <BrandError
          message="We couldn't load your receipts. Please try again."
          onRetry={() => void refetch()}
        />
      ) : isLoading ? (
        <div className="space-y-3" aria-busy="true">
          {Array.from({ length: 3 }).map((_unused, i) => (
            <Placeholder key={i} className="h-24 w-full" />
          ))}
        </div>
      ) : rows.length === 0 ? (
        <BrandEmpty
          title="No receipts yet"
          hint="A receipt is issued when a booking is confirmed, and it will appear here."
          headingLevel="h2"
        />
      ) : (
        <ul className="space-y-3">
          {rows.map((r) => (
            <li key={r.id}>
              <div
                className={`flex flex-wrap items-center justify-between gap-4 ${ACCOUNT_PANEL} p-4 sm:p-5`}
              >
                <div className="min-w-0">
                  <p className="truncate font-brand-display text-brand-card text-brand-ink">
                    {r.booking.event.title}
                  </p>
                  <p className="mt-1 text-brand-meta text-brand-ink-2">
                    {KIND_LABEL[r.kind] ?? r.kind} {r.number} - {dateOnly(r.issuedAt)}
                    {r.booking.reference && ` - ${r.booking.reference}`}
                  </p>
                </div>
                <div className="flex items-center gap-3">
                  {/* The currency is the booking's, never a default — see `money`. */}
                  <span className="text-brand-ui font-semibold tabular-nums text-brand-ink">
                    {money(r.totalMinor, r.currency)}
                  </span>
                  <BrandButton
                    variant="secondary"
                    aria-busy={opening === r.id || undefined}
                    disabled={opening === r.id}
                    onClick={() => open(r.id)}
                  >
                    Open
                  </BrandButton>
                </div>
              </div>
            </li>
          ))}
        </ul>
      )}
    </AccountPage>
  );
}
