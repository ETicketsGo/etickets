'use client';

import { useMutation } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';
import { FileText, RotateCcw, UserPlus } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { errorMessage, isFreeCancellation, useIsAuthenticated } from '@eticketsgo/web-kit';
import { api, ApiRequestError } from '@/lib/api';
import { useFormat } from '@/lib/format';
import { brandButtonClasses } from '@eticketsgo/web-kit';
import { Link } from '@/i18n/navigation';
import { BRAND_EYEBROW, BRAND_PANEL } from '@/components/booking-brand';
import {
  BRAND_ALERT,
  BRAND_INSET,
  BrandActionButton,
  BrandInput,
  BrandTextarea,
} from '@/components/brand-forms';
import { useRouter, usePathname } from '@/i18n/navigation';
import { useStatusLabel } from '@/lib/status-label';

/**
 * The three things a guest could not do from an emailed booking link: get the invoice, ask for
 * the money back, and put the booking in an account.
 *
 * ── WHY TWO OF THEM ASK FOR AN EMAIL ADDRESS AND THE TICKETS DO NOT ────────────────
 * The link is the only credential, and a link in an email gets forwarded. That is acceptable
 * for the tickets: whoever holds the link is going to be shown the QR at the door anyway. It
 * is not acceptable for an invoice, which carries the buyer's name and what they paid, and it
 * is not acceptable for a refund, which gives somebody else's tickets away. So both ask for
 * one thing the forwarding does not carry -- the address the booking was paid with -- and the
 * page says so in those words rather than making the reader guess why it wants an email again.
 *
 * The booking view already prints that address masked, as "gu***@e2e.test". That is the hint
 * the real buyer needs and the hint a stranger cannot work backwards from.
 *
 * ── WHY THE SERVER DECIDES, NOT THIS FILE ──────────────────────────────────────────
 * Whether an invoice exists, and whether a refund is still allowed, are answers only the API
 * has: a cutoff, a cash payment, a refund already made. Nothing here predicts them. A refused
 * refund shows the server's own explanation, because "something went wrong" sends a person to
 * support to be told what the API had already said.
 */

/** The three cards on the brand layer, as the panels beside them on the same pages. */
const PANEL = `${BRAND_PANEL} space-y-3 p-4 sm:p-6`;
const PANEL_TITLE = 'font-brand-display text-brand-card text-brand-ink';

/** Anything that looks like an address. The same loose test the guest checkout form uses. */
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

/**
 * That the reader asked to claim this booking before they were sent off to sign in.
 *
 * ── WHY sessionStorage AND NOT A QUERY PARAMETER ───────────────────────────────────
 * Both pages that offer the claim are reached in ways that must keep working: a forwarded
 * link, a page reloaded on a phone, a browser that restores tabs. A marker in this tab is
 * enough, expires with the tab, and keeps the intent out of a URL that gets shared.
 *
 * It is a convenience, never the permission. Losing it costs the reader one press of a button
 * that is on the page anyway, which is why every access is wrapped: a browser with site data
 * blocked throws here rather than returning null.
 */
const CLAIM_INTENT_KEY = 'etg_guest_claim';

function readClaimIntent(): string | null {
  try {
    return sessionStorage.getItem(CLAIM_INTENT_KEY);
  } catch {
    return null;
  }
}

function writeClaimIntent(bookingId: string): void {
  try {
    sessionStorage.setItem(CLAIM_INTENT_KEY, bookingId);
  } catch {
    /* The button on the page still finishes the job by hand. */
  }
}

function clearClaimIntent(): void {
  try {
    sessionStorage.removeItem(CLAIM_INTENT_KEY);
  } catch {
    /* ignore */
  }
}

/** The status of a failed call, when the failure came from the API rather than the network. */
function statusOf(error: unknown): number | undefined {
  return error instanceof ApiRequestError ? error.status : undefined;
}

/**
 * Get the invoice, given the address that paid.
 *
 * The document arrives as one complete rendered page. It is shown in a frame so a buyer on a
 * phone can read it where they are, and offered in a new tab as well because printing and
 * "save as PDF" belong to the browser's own controls. The frame is fully sandboxed: it is a
 * finished document and has no reason to run anything.
 */
export function GuestInvoiceCard({ token, emailMasked }: { token: string; emailMasked: string }) {
  const g = useTranslations('storefront.guest');
  const d = useTranslations('documents');
  const { money, dateTime } = useFormat();
  const [email, setEmail] = useState('');
  const [invalid, setInvalid] = useState<string | null>(null);

  const invoice = useMutation({
    mutationFn: (address: string) => api.guestBookingReceipt(token, address),
  });

  const status = statusOf(invoice.error);
  // 403 is the one refusal that belongs on the field: the address is what was wrong with it.
  const mismatch = status === 403;
  const fieldError = invalid ?? (mismatch ? g('emailMismatch') : undefined);
  const otherError = invoice.error && !mismatch ? errorMessage(invoice.error) : null;
  const documents = invoice.data?.documents ?? [];
  const html = invoice.data?.html ?? '';
  // A list with no document, or a document that rendered to nothing, is the same thing to read.
  const nothingIssued = invoice.isSuccess && (documents.length === 0 || !html);

  const submit = (event: React.FormEvent) => {
    event.preventDefault();
    const address = email.trim();
    if (!address) return setInvalid(g('payerEmailRequired'));
    if (!EMAIL.test(address)) return setInvalid(g('emailInvalid'));
    setInvalid(null);
    invoice.mutate(address);
  };

  const reset = () => {
    invoice.reset();
    setInvalid(null);
  };

  /*
    A blob rather than an href to the API.

    The document is already in the browser -- it came back in the response -- so opening it is
    a synchronous step inside the click, which is what keeps a phone from treating the new tab
    as an unasked-for popup. It also means no second tab fetching a document with no way to
    prove who it is.
  */
  const openInNewTab = () => {
    const url = URL.createObjectURL(new Blob([html], { type: 'text/html' }));
    window.open(url, '_blank', 'noopener');
    // Released later: revoking at once can beat the new tab to the load.
    setTimeout(() => URL.revokeObjectURL(url), 60_000);
  };

  return (
    <section className={PANEL}>
      <h2 className={`flex items-center gap-2 ${PANEL_TITLE}`}>
        <FileText className="h-4 w-4 shrink-0" aria-hidden />
        {g('invoiceTitle')}
      </h2>
      <p className="text-brand-ui text-brand-ink-2">{g('invoiceBody')}</p>

      {invoice.isSuccess ? (
        <div className="space-y-3">
          {nothingIssued ? (
            <p className="text-brand-ui text-brand-ink-2">{g('invoiceNone')}</p>
          ) : (
            <>
              <div className="space-y-2 border-t border-brand-line pt-4">
                <p className={BRAND_EYEBROW}>{g('invoiceHeading')}</p>
                {documents.map((doc) => (
                  <div key={doc.id} className="flex justify-between gap-4 text-brand-ui">
                    <span className="text-brand-ink">
                      {g('invoiceLine', {
                        kind: d.has(`kind.${doc.kind}`)
                          ? d(`kind.${doc.kind}`)
                          : d('kind.FALLBACK'),
                        number: doc.number,
                      })}
                    </span>
                    <span className="tabular-nums text-brand-ink-2">
                      {money(doc.totalMinor, doc.currency)}
                    </span>
                  </div>
                ))}
                {documents[0]?.issuedAt ? (
                  <p className="text-brand-meta text-brand-ink-3">
                    {g('invoiceIssued', { when: dateTime(documents[0].issuedAt) })}
                  </p>
                ) : null}
              </div>
              <iframe
                title={g('invoiceFrameTitle')}
                srcDoc={html}
                sandbox=""
                className="h-[60vh] w-full rounded-brand-control border border-brand-line bg-white"
              />
              <BrandActionButton variant="secondary" className="w-full" onClick={openInNewTab}>
                {g('invoiceOpenTab')}
              </BrandActionButton>
            </>
          )}
          <BrandActionButton variant="quiet" className="w-full" onClick={reset}>
            <RotateCcw className="h-4 w-4" aria-hidden />
            {g('invoiceRedo')}
          </BrandActionButton>
        </div>
      ) : (
        <form className="space-y-3" onSubmit={submit}>
          <p className="text-brand-meta text-brand-ink-3">{g('whyEmail')}</p>
          <BrandInput
            id="guest-invoice-email"
            label={g('payerEmailLabel')}
            type="email"
            inputMode="email"
            autoComplete="email"
            value={email}
            error={fieldError}
            hint={g('paidWith', { email: emailMasked })}
            onChange={(e) => {
              setEmail(e.target.value);
              setInvalid(null);
            }}
          />
          {otherError ? (
            <p role="alert" className={BRAND_ALERT}>
              {otherError}
            </p>
          ) : null}
          <BrandActionButton type="submit" className="w-full" loading={invoice.isPending}>
            {g('invoiceSubmit')}
          </BrandActionButton>
        </form>
      )}
    </section>
  );
}

/**
 * Ask the organizer for the money back, given the address that paid.
 *
 * ── WHY A REFUSAL IS NOT AN ERROR HERE ─────────────────────────────────────────────
 * 409 means the booking cannot be refunded, and the API's message says which rule stopped it:
 * the cutoff has passed, a refund has already been made, the ticket was paid for in cash. That
 * sentence is the whole answer, so it is shown as the answer. A toast saying "something went
 * wrong" would send somebody to support to be told what the server had already told us.
 */
export function GuestRefundCard({ token, emailMasked }: { token: string; emailMasked: string }) {
  const g = useTranslations('storefront.guest');
  const { money } = useFormat();
  const statusLabel = useStatusLabel();
  const [email, setEmail] = useState('');
  const [reason, setReason] = useState('');
  const [invalid, setInvalid] = useState<string | null>(null);

  const refund = useMutation({
    mutationFn: (body: { email: string; reason?: string }) => api.guestBookingRefund(token, body),
  });

  const status = statusOf(refund.error);
  const mismatch = status === 403;
  const refused = status === 409;
  const fieldError = invalid ?? (mismatch ? g('emailMismatch') : undefined);
  const otherError = refund.error && !mismatch && !refused ? errorMessage(refund.error) : null;
  /*
    A free booking is cancelled outright rather than queued for somebody to decide, so it comes
    back without an id or a status. Read the money fields only from the shape that has them.
  */
  const requested = refund.data && !isFreeCancellation(refund.data) ? refund.data : null;
  const currency = requested?.booking?.currency;
  const amountMinor = requested?.amountMinor;

  const submit = (event: React.FormEvent) => {
    event.preventDefault();
    const address = email.trim();
    if (!address) return setInvalid(g('payerEmailRequired'));
    if (!EMAIL.test(address)) return setInvalid(g('emailInvalid'));
    setInvalid(null);
    // A blank reason is left out rather than sent as an empty string: the reason is optional.
    const note = reason.trim();
    refund.mutate({ email: address, reason: note || undefined });
  };

  // Nothing was paid, so nothing is being decided: the tickets are already gone.
  if (refund.isSuccess && !requested)
    return (
      <section className={PANEL}>
        <h2 className={PANEL_TITLE}>{g('refundFreeTitle')}</h2>
        <p className="text-brand-ui text-brand-ink-2">{g('refundFreeBody')}</p>
      </section>
    );

  if (refund.isSuccess && requested)
    return (
      <section className={PANEL}>
        <h2 className={PANEL_TITLE}>{g('refundSentTitle')}</h2>
        <p className="text-brand-ui text-brand-ink-2">{g('refundSentBody')}</p>
        <p className="text-brand-meta text-brand-ink-3">
          {g('refundStatusLine', { status: statusLabel('refund', requested.status) })}
        </p>
        {/* The amount, only when the API named one: a free cancellation returns no money. */}
        {typeof amountMinor === 'number' && currency ? (
          <p className="text-brand-meta text-brand-ink-3">
            {g('refundAmountLine', { amount: money(amountMinor, currency) })}
          </p>
        ) : null}
      </section>
    );

  return (
    <section className={PANEL}>
      <h2 className={PANEL_TITLE}>{g('refundTitle')}</h2>
      <p className="text-brand-ui text-brand-ink-2">{g('refundBody')}</p>

      {refused ? (
        <div className={BRAND_INSET}>
          <p className="text-brand-ui font-semibold text-brand-ink">{g('refundRefusedTitle')}</p>
          {/* The server's own sentence. It names the rule, and this page cannot. */}
          <p className="mt-1 text-brand-meta text-brand-ink-2">{errorMessage(refund.error)}</p>
        </div>
      ) : (
        <form className="space-y-3" onSubmit={submit}>
          <p className="text-brand-meta text-brand-ink-3">{g('whyEmail')}</p>
          <BrandInput
            id="guest-refund-email"
            label={g('payerEmailLabel')}
            type="email"
            inputMode="email"
            autoComplete="email"
            value={email}
            error={fieldError}
            hint={g('paidWith', { email: emailMasked })}
            onChange={(e) => {
              setEmail(e.target.value);
              setInvalid(null);
            }}
          />
          <BrandTextarea
            id="guest-refund-reason"
            label={g('refundReasonLabel')}
            rows={3}
            value={reason}
            hint={g('refundReasonHint')}
            onChange={(e) => setReason(e.target.value)}
          />
          {otherError ? (
            <p role="alert" className={BRAND_ALERT}>
              {otherError}
            </p>
          ) : null}
          <BrandActionButton type="submit" className="w-full" loading={refund.isPending}>
            {g('refundSubmit')}
          </BrandActionButton>
        </form>
      )}
    </section>
  );
}

/**
 * Put a guest booking in an account.
 *
 * ── WHY THIS IS THE ONE GUEST ACTION THAT NEEDS SIGNING IN ─────────────────────────
 * There is no account to attach the booking to until there is one. A signed-out reader is
 * therefore sent to sign in and brought back here, and the claim finishes by itself on return
 * -- being made to press the same button a second time after signing in reads as though the
 * first press did nothing.
 *
 * ── WHY 409 IS A SENTENCE AND NOT A TOAST ──────────────────────────────────────────
 * It means the booking already belongs to a different account, which happens when a link was
 * forwarded and the other person got there first. Nothing about that is retryable, and the
 * reader needs to be told which account to sign in with instead.
 */
export function GuestClaimCard({
  bookingId,
  accessToken,
  anonSession,
}: {
  bookingId: string;
  /** From an emailed link, when this card is on the access page. */
  accessToken?: string;
  /** From this browser, when it is the one that made the booking. */
  anonSession?: string | null;
}) {
  const g = useTranslations('storefront.guest');
  const authed = useIsAuthenticated();
  const router = useRouter();
  const pathname = usePathname();

  const claim = useMutation({
    mutationFn: () =>
      api.claimGuestBooking(
        bookingId,
        accessToken ? { accessToken } : {},
        anonSession ?? undefined,
      ),
  });
  const { mutate } = claim;

  /*
    Finish what the reader started before they were sent to sign in.

    Once only, and guarded by a ref rather than by the mutation's own state: react-query resets
    nothing on a failure, so a claim that was refused must not be attempted again on every
    render.
  */
  const resumed = useRef(false);
  useEffect(() => {
    if (!authed || resumed.current) return;
    if (readClaimIntent() !== bookingId) return;
    resumed.current = true;
    clearClaimIntent();
    mutate();
  }, [authed, bookingId, mutate]);

  const signInAndReturn = () => {
    writeClaimIntent(bookingId);
    // The locale-less path: the router puts the reader's language back on the front of it.
    router.push(`/login?next=${encodeURIComponent(pathname)}`);
  };

  if (claim.isSuccess)
    return (
      <section className={PANEL}>
        <h2 className={PANEL_TITLE}>{g('claimSavedTitle')}</h2>
        <p className="text-brand-ui text-brand-ink-2">{g('claimSavedBody')}</p>
        <Link
          href="/account/bookings"
          className={`${brandButtonClasses('secondary', 'md')} w-full`}
        >
          {g('claimMyBookings')}
        </Link>
      </section>
    );

  if (statusOf(claim.error) === 409)
    return (
      <section className={PANEL}>
        <h2 className={PANEL_TITLE}>{g('claimTakenTitle')}</h2>
        <p className="text-brand-ui text-brand-ink-2">{g('claimTakenBody')}</p>
      </section>
    );

  return (
    <section className={PANEL}>
      <h2 className={`flex items-center gap-2 ${PANEL_TITLE}`}>
        <UserPlus className="h-4 w-4 shrink-0" aria-hidden />
        {g('claimTitle')}
      </h2>
      <p className="text-brand-ui text-brand-ink-2">{g('claimBody')}</p>
      {claim.error ? (
        <p role="alert" className={BRAND_ALERT}>
          {errorMessage(claim.error)}
        </p>
      ) : null}
      {authed ? (
        <>
          {claim.isPending ? (
            <p className="text-brand-meta text-brand-ink-3">{g('claimWorking')}</p>
          ) : null}
          <BrandActionButton
            className="w-full"
            loading={claim.isPending}
            onClick={() => claim.mutate()}
          >
            {g('claimSubmit')}
          </BrandActionButton>
        </>
      ) : (
        <>
          <p className="text-brand-meta text-brand-ink-3">{g('claimSignInNote')}</p>
          <BrandActionButton className="w-full" onClick={signInAndReturn}>
            {g('claimSignIn')}
          </BrandActionButton>
        </>
      )}
    </section>
  );
}
