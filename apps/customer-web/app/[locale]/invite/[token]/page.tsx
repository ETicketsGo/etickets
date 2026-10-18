'use client';

import { useMutation } from '@tanstack/react-query';
import { useParams } from 'next/navigation';
import { useRouter } from '@/i18n/navigation';
import { useEffect, useState } from 'react';
import { Ticket, CheckCircle2 } from 'lucide-react';
import { errorMessage } from '@eticketsgo/web-kit';
import { api, tokenStore } from '@/lib/api';
import { brandButtonClasses } from '@eticketsgo/web-kit';
import { Link } from '@/i18n/navigation';
import {
  BRAND_ALERT,
  BRAND_LEAD,
  BRAND_NOTE,
  BRAND_PAGE_TITLE,
  BrandActionButton,
  BrandCenteredPage,
  BrandFormPanel,
} from '@/components/brand-forms';

/**
 * Public-facing claim page for an attendee invitation. The recipient must be
 * signed in so the ticket can be linked to their account (and their wallet);
 * accepting rotates the ticket's QR server-side, invalidating the old one.
 */
export default function InviteClaimPage() {
  const { token } = useParams<{ token: string }>();
  const router = useRouter();
  const [signedIn, setSignedIn] = useState(false);
  const [done, setDone] = useState<'accepted' | 'declined' | null>(null);

  useEffect(() => {
    setSignedIn(!!tokenStore.access);
  }, []);

  const accept = useMutation({
    mutationFn: () => api.acceptInvite(token),
    onSuccess: () => setDone('accepted'),
  });
  const decline = useMutation({
    mutationFn: () => api.declineInvite(token),
    onSuccess: () => setDone('declined'),
  });

  const loginHref = `/login?next=${encodeURIComponent(`/invite/${token}`)}`;

  if (done === 'accepted')
    return (
      <Wrapper>
        <span
          aria-hidden
          className="mx-auto flex h-14 w-14 items-center justify-center rounded-full bg-brand-positive-tint text-brand-positive"
        >
          <CheckCircle2 className="h-7 w-7" />
        </span>
        <h1 className={`mt-4 ${BRAND_PAGE_TITLE}`}>Ticket added to your wallet</h1>
        <p className={`mt-2 ${BRAND_LEAD}`}>
          A fresh QR has been issued to you. The previous code no longer works.
        </p>
        <div className="mt-6">
          <Link href="/account/tickets" className={brandButtonClasses('primary', 'lg')}>
            Go to my tickets
          </Link>
        </div>
      </Wrapper>
    );

  if (done === 'declined')
    return (
      <Wrapper>
        <h1 className={BRAND_PAGE_TITLE}>Invitation declined</h1>
        <p className={`mt-2 ${BRAND_LEAD}`}>No problem - we&apos;ve let the sender know.</p>
        <div className="mt-6">
          <Link href="/events" className={brandButtonClasses('secondary', 'lg')}>
            Browse events
          </Link>
        </div>
      </Wrapper>
    );

  return (
    <Wrapper>
      <span
        aria-hidden
        className="mx-auto flex h-14 w-14 items-center justify-center rounded-full bg-brand-marigold text-brand-on-marigold"
      >
        <Ticket className="h-7 w-7" />
      </span>
      <h1 className={`mt-4 ${BRAND_PAGE_TITLE}`}>You&apos;ve been given a ticket</h1>
      <p className={`mt-2 ${BRAND_LEAD}`}>
        Accept it to add the ticket to your ETicketsGo wallet with your own QR code.
      </p>

      {(accept.isError || decline.isError) && (
        <p role="alert" className={`mt-4 ${BRAND_ALERT}`}>
          {errorMessage(accept.error ?? decline.error)}
        </p>
      )}

      {signedIn ? (
        <div className="mt-6 flex flex-col gap-2 sm:flex-row sm:justify-center">
          <BrandActionButton size="lg" loading={accept.isPending} onClick={() => accept.mutate()}>
            Accept ticket
          </BrandActionButton>
          <BrandActionButton
            variant="secondary"
            size="lg"
            loading={decline.isPending}
            onClick={() => decline.mutate()}
          >
            Decline
          </BrandActionButton>
        </div>
      ) : (
        <div className="mt-6 space-y-2">
          <p className={BRAND_NOTE}>Sign in or create an account to claim it.</p>
          <BrandActionButton size="lg" onClick={() => router.push(loginHref)}>
            Sign in to claim
          </BrandActionButton>
        </div>
      )}
    </Wrapper>
  );
}

function Wrapper({ children }: { children: React.ReactNode }) {
  return (
    <BrandCenteredPage>
      <BrandFormPanel className="text-center">{children}</BrandFormPanel>
    </BrandCenteredPage>
  );
}
