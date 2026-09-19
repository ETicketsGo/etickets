'use client';

import { useMutation } from '@tanstack/react-query';
import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { MailCheck } from 'lucide-react';
import { api } from '@/lib/api';
import { Button, Card, Input } from '@/components/ui';
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
      <Card className="mx-auto max-w-sm space-y-3 text-center">
        <MailCheck className="mx-auto h-8 w-8 text-status-success" aria-hidden />
        <h1 className="text-title font-semibold text-text-primary">{g('findSentTitle')}</h1>
        <p className="text-[0.9375rem] text-text-secondary">{g('findSentBody')}</p>
        <p className="text-caption text-text-muted">{g('findSentHint')}</p>
        <Button variant="outline" className="w-full" onClick={() => lookup.reset()}>
          {g('findAgain')}
        </Button>
      </Card>
    );
  }

  return (
    <Card className="mx-auto max-w-sm space-y-4">
      <div>
        <h1 className="text-h2 font-bold text-text-primary">{g('findTitle')}</h1>
        <p className="mt-1.5 text-[0.9375rem] text-text-secondary">{g('findLead')}</p>
      </div>

      <form className="space-y-4" onSubmit={submit}>
        <Input
          id="booking-reference"
          label={g('findReferenceLabel')}
          hint={g('findReferenceHint')}
          autoComplete="off"
          autoCapitalize="characters"
          value={reference}
          error={errors.reference}
          onChange={(e) => setReference(e.target.value.toUpperCase())}
        />
        <Input
          id="booking-email"
          label={g('emailLabel')}
          type="email"
          inputMode="email"
          autoComplete="email"
          value={email}
          error={errors.email}
          onChange={(e) => setEmail(e.target.value)}
        />
        <Button type="submit" className="w-full" loading={lookup.isPending}>
          {g('findSubmit')}
        </Button>
      </form>

      <p className="text-caption text-text-muted">
        {g('findHaveAccount')}{' '}
        <Link href="/login" className="text-action-primary underline">
          {a('signIn')}
        </Link>
      </p>
    </Card>
  );
}
