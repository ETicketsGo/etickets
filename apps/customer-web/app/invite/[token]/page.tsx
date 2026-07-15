'use client';

import { useMutation } from '@tanstack/react-query';
import { useParams, useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import { Ticket, CheckCircle2 } from 'lucide-react';
import { errorMessage } from '@eticketsgo/web-kit';
import { api, tokenStore } from '@/lib/api';
import { Button, ButtonLink, Card } from '@/components/ui';

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
        <CheckCircle2 className="mx-auto h-12 w-12 text-status-success" />
        <h1 className="mt-4 text-h3 font-bold text-text-primary">Ticket added to your wallet</h1>
        <p className="mt-1.5 text-[0.9375rem] text-text-secondary">
          A fresh QR has been issued to you. The previous code no longer works.
        </p>
        <div className="mt-6">
          <ButtonLink href="/account/tickets">Go to my tickets</ButtonLink>
        </div>
      </Wrapper>
    );

  if (done === 'declined')
    return (
      <Wrapper>
        <h1 className="text-h3 font-bold text-text-primary">Invitation declined</h1>
        <p className="mt-1.5 text-[0.9375rem] text-text-secondary">
          No problem — we’ve let the sender know.
        </p>
        <div className="mt-6">
          <ButtonLink href="/events" variant="outline">
            Browse events
          </ButtonLink>
        </div>
      </Wrapper>
    );

  return (
    <Wrapper>
      <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-full bg-action-primary/10 text-action-primary">
        <Ticket className="h-6 w-6" />
      </div>
      <h1 className="mt-4 text-h3 font-bold text-text-primary">You’ve been given a ticket</h1>
      <p className="mt-1.5 text-[0.9375rem] text-text-secondary">
        Accept it to add the ticket to your ETicketsGo wallet with your own QR code.
      </p>

      {(accept.isError || decline.isError) && (
        <p role="alert" className="mt-4 text-caption text-status-error">
          {errorMessage(accept.error ?? decline.error)}
        </p>
      )}

      {signedIn ? (
        <div className="mt-6 flex flex-col gap-2 sm:flex-row sm:justify-center">
          <Button loading={accept.isPending} onClick={() => accept.mutate()}>
            Accept ticket
          </Button>
          <Button variant="outline" loading={decline.isPending} onClick={() => decline.mutate()}>
            Decline
          </Button>
        </div>
      ) : (
        <div className="mt-6 space-y-2">
          <p className="text-caption text-text-muted">Sign in or create an account to claim it.</p>
          <Button onClick={() => router.push(loginHref)}>Sign in to claim</Button>
        </div>
      )}
    </Wrapper>
  );
}

function Wrapper({ children }: { children: React.ReactNode }) {
  return (
    <div className="mx-auto max-w-md py-8">
      <Card className="text-center">{children}</Card>
    </div>
  );
}
