'use client';

import { useMutation, useQuery } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';
import { useRouter } from '@/i18n/navigation';
import { api as wk, tokenStore, useAuthUser } from '@eticketsgo/web-kit';
import { Button, Card, Input } from '@/components/ui';
import { ApiRequestError } from '@/lib/api';
import { Link } from '@/i18n/navigation';
import { useMounted } from '@/lib/use-mounted';

const ORGANIZER_URL = process.env.NEXT_PUBLIC_ORGANIZER_URL ?? 'http://localhost:3001';

/**
 * Turn a customer account into an organizer account.
 *
 * ── WHY THE ORGANIZATION IS CREATED HERE, NOT IN THE ORGANIZER APP ────────────────
 * The session lives in this origin's localStorage. The customer site and the organizer
 * console are different origins (:3000 and :3001 locally, separate hosts in every deployed
 * environment), so a token set here is simply not visible there.
 *
 * The old "become an organizer" path ignored that: registering with `?intent=organizer` set
 * the tokens on THIS origin and then sent the browser to the organizer app, which saw a
 * signed-out visitor, bounced it to its login screen, and refused the account for lacking a
 * role that only creating an organization grants. Three steps, each individually sensible,
 * composing into a loop with no exit.
 *
 * Creating the organization on the side that actually holds the session breaks that. The one
 * remaining step is a genuine sign-in on the other origin — which now succeeds, because by
 * then the account really is an organizer.
 */
export default function BecomeOrganizerPage() {
  const t = useTranslations('storefront.becomeOrganizer');
  const router = useRouter();
  const { user } = useAuthUser();
  const [name, setName] = useState('');
  const [contactEmail, setContactEmail] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [created, setCreated] = useState(false);
  const mounted = useMounted();

  useEffect(() => {
    if (typeof window !== 'undefined' && !tokenStore.access) {
      router.replace('/login?next=/account/become-organizer');
    }
  }, [router]);

  const mine = useQuery({
    queryKey: ['organizations', 'mine'],
    queryFn: () => wk.organizations.listMine(),
    // Not `typeof window`, which differs between server and first client render. See useMounted.
    enabled: mounted && !!tokenStore.access,
    retry: false,
  });

  const create = useMutation({
    mutationFn: async () => {
      await wk.organizations.create({
        name: name.trim(),
        contactEmail: contactEmail.trim() || user?.email || undefined,
      });
      /*
        Refresh before sending them on. Creating the organization granted ORGANIZER_OWNER in
        the database, but the token in this browser still describes the account as it was a
        moment ago — and the organizer console reads the token, not the database.
      */
      const refresh = tokenStore.refresh;
      if (refresh) {
        const tokens = await wk.auth.refresh(refresh);
        tokenStore.set(tokens);
      }
    },
    onSuccess: () => setCreated(true),
    onError: (e) =>
      setError(
        e instanceof ApiRequestError && e.code === 'RATE_LIMITED'
          ? t('rateLimited')
          : e instanceof ApiRequestError
            ? e.message
            : t('failed'),
      ),
  });

  const consoleHref = `${ORGANIZER_URL}/login${
    user?.email ? `?email=${encodeURIComponent(user.email)}` : ''
  }`;

  if (created || (mine.data && mine.data.length > 0)) {
    return (
      <Card className="mx-auto max-w-sm space-y-4">
        <h1 className="text-h2 font-bold text-text-primary">
          {created ? t('readyTitle') : t('alreadyTitle')}
        </h1>
        <p className="text-caption text-text-muted">{t('separateSignIn')}</p>
        {/* A plain anchor, not next/link: this leaves the app for a different origin, and a
            client-side navigation would not carry the session there anyway. */}
        <a
          href={consoleHref}
          data-testid="open-organizer-console"
          className="inline-flex w-full items-center justify-center rounded-md bg-action-primary px-4 py-2 font-medium text-action-primary-foreground transition-colors hover:opacity-90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:ring-offset-2"
        >
          {t('openConsole')}
        </a>
        {created ? <p className="text-caption text-text-muted">{t('reviewNote')}</p> : null}
      </Card>
    );
  }

  return (
    <Card className="mx-auto max-w-sm space-y-4">
      <div>
        <h1 className="text-h2 font-bold text-text-primary">{t('heading')}</h1>
        <p className="mt-1 text-caption text-text-muted">{t('lead')}</p>
      </div>

      <form
        className="space-y-4"
        onSubmit={(e) => {
          e.preventDefault();
          setError(null);
          create.mutate();
        }}
      >
        <Input
          id="org-name"
          label={t('orgName')}
          autoFocus
          value={name}
          onChange={(e) => setName(e.target.value)}
          minLength={2}
          required
        />
        <Input
          id="org-contact"
          label={t('supportEmail')}
          type="email"
          placeholder={user?.email ?? ''}
          value={contactEmail}
          onChange={(e) => setContactEmail(e.target.value)}
        />

        {error ? (
          <p role="alert" className="text-caption text-status-error">
            {error}
          </p>
        ) : null}

        <Button
          type="submit"
          className="w-full"
          loading={create.isPending}
          disabled={create.isPending || name.trim().length < 2}
        >
          {t('create')}
        </Button>
      </form>

      <p className="text-caption text-text-muted">
        {t('changedMind')}{' '}
        <Link href="/account" className="text-action-primary underline">
          {t('backToAccount')}
        </Link>
      </p>
    </Card>
  );
}
