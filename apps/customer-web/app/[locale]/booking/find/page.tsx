'use client';

import { useMutation } from '@tanstack/react-query';
import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { MailCheck } from 'lucide-react';
import { api } from '@/lib/api';
import {
  BRAND_LEAD,
  BRAND_NOTE,
  BRAND_PAGE_TITLE,
  BrandActionButton,
  BrandCenteredPage,
  BrandFormPanel,
  BrandInput,
} from '@/components/brand-forms';
import { BRAND_LINK } from '@/components/booking-brand';
import { Link } from '@/i18n/navigation';

/**
 * Find my booking.
 *
 * ── WHY THE ANSWER IS ALWAYS THE SAME ──────────────────────────────────────────────
 * The form takes a booking reference and an email address, and whatever the pair turns out to
 * be it says "if that booking exists, we have emailed a link to it". It never confirms a match.
 *
 * A page that answered honestly would be a lookup service: references are sequential, so
 * anybody could hold one and test addresses against it until the page said yes, and that
 * answer is "this person bought a ticket to this show". The email either arrives or it does
 * not, and only the person holding the mailbox learns which.
 *
 * That is also why the button is not a search and does not say "search". Nothing is displayed
 * here. The link in the email is the way in.
 */
export default function FindBookingPage() {
  const g = useTranslations('storefront.guest');
  const a = useTranslations('storefront.auth');
  const [reference, setReference] = useState('');
  const [email, setEmail] = useState('');
  const [errors, setErrors] = useState<{ reference?: string; email?: string }>({});

  const lookup = useMutation({
    mutationFn: (body: { reference: string; email: string }) => api.guestBookingLookup(body),
  });

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    const ref = reference.trim().toUpperCase();
    const address = email.trim();
    const next: { reference?: string; email?: string } = {};
    if (!ref) next.reference = g('findReferenceRequired');
    if (!address) next.email = g('emailRequired');
    setErrors(next);
    if (next.reference || next.email) return;
    lookup.mutate({ reference: ref, email: address });
  };

  /*
    The same message for a match, a miss and a server that refused the call.

    A failure shown as a failure is itself an answer: "that reference is not one of ours" is
    exactly what this page must not say. The buyer is told what to do next either way, and
    nothing here can be used to test whether a booking exists.
  */
  if (lookup.isSuccess || lookup.isError) {
    return (
      <BrandCenteredPage>
        <BrandFormPanel className="space-y-4 text-center">
          <span
            aria-hidden
            className="mx-auto flex h-14 w-14 items-center justify-center rounded-full bg-brand-positive-tint text-brand-positive"
          >
            <MailCheck className="h-7 w-7" />
          </span>
          <h1 className={BRAND_PAGE_TITLE}>{g('findSentTitle')}</h1>
          <p className={BRAND_LEAD}>{g('findSentBody')}</p>
          <p className={BRAND_NOTE}>{g('findSentHint')}</p>
          <BrandActionButton variant="secondary" className="w-full" onClick={() => lookup.reset()}>
            {g('findAgain')}
          </BrandActionButton>
        </BrandFormPanel>
      </BrandCenteredPage>
    );
  }

  return (
    <BrandCenteredPage>
      <BrandFormPanel className="space-y-5">
        <div>
          <h1 className={BRAND_PAGE_TITLE}>{g('findTitle')}</h1>
          <p className={`mt-2 ${BRAND_LEAD}`}>{g('findLead')}</p>
        </div>

        <form className="space-y-5" onSubmit={submit}>
          <BrandInput
            id="booking-reference"
            label={g('findReferenceLabel')}
            hint={g('findReferenceHint')}
            autoComplete="off"
            autoCapitalize="characters"
            value={reference}
            error={errors.reference}
            onChange={(e) => setReference(e.target.value.toUpperCase())}
          />
          <BrandInput
            id="booking-email"
            label={g('emailLabel')}
            type="email"
            inputMode="email"
            autoComplete="email"
            value={email}
            error={errors.email}
            onChange={(e) => setEmail(e.target.value)}
          />
          <BrandActionButton type="submit" size="lg" className="w-full" loading={lookup.isPending}>
            {g('findSubmit')}
          </BrandActionButton>
        </form>

        <p className={`border-t border-brand-line pt-5 ${BRAND_NOTE}`}>
          {g('findHaveAccount')}{' '}
          {/* Somebody looking for a booking who has an account wants their tickets. */}
          <Link
            href={`/login?next=${encodeURIComponent('/account/tickets')}`}
            className={BRAND_LINK}
          >
            {a('signIn')}
          </Link>
        </p>
      </BrandFormPanel>
    </BrandCenteredPage>
  );
}
