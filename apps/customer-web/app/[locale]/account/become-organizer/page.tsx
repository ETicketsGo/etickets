'use client';

import { useMutation, useQuery } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';
import { useRouter } from '@/i18n/navigation';
import {
  BrandButton,
  MARKETS,
  api as wk,
  brandButtonClasses,
  marketFor,
  tokenStore,
  useAuthUser,
} from '@eticketsgo/web-kit';
import { ApiRequestError } from '@/lib/api';
import {
  ACCOUNT_PANEL,
  AccountPage,
  BrandSelectField,
  BrandTextField,
} from '@/components/account-brand';
import { BRAND_LINK } from '@/components/booking-brand';
import { Link } from '@/i18n/navigation';
import { useMounted } from '@/lib/use-mounted';

import { ORGANIZER_LOGIN_URL, openOrganizerConsole } from '@/lib/organizer-console';
import { OrganizerEmailStep } from '@/components/organizer-email-step';

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
 *
 * On the brand layer: one flat white panel on paper with the brand's fields and an ink button.
 * Same fields, same ids, same order, same rules and the same link out to the console.
 */
export default function BecomeOrganizerPage() {
  const t = useTranslations('storefront.becomeOrganizer');
  const router = useRouter();
  const { user } = useAuthUser();
  const [name, setName] = useState('');
  const [contactEmail, setContactEmail] = useState('');
  /*
    Who they legally are, asked at registration. The approval gate has always required it,
    so without these the first thing that happened to every new organizer was an admin
    writing to ask for facts this form never requested.
  */
  const [country, setCountry] = useState('');
  const [entityType, setEntityType] = useState('');
  const [legalName, setLegalName] = useState('');
  const entityTypes = marketFor(country)?.legalEntityTypes ?? [];
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
        legalName: legalName.trim(),
        legalEntityType: entityType,
        registeredCountry: country,
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

  const consoleHref = `${ORGANIZER_LOGIN_URL}${
    user?.email ? `?email=${encodeURIComponent(user.email)}` : ''
  }`;
  const [opening, setOpening] = useState(false);

  if (created || (mine.data && mine.data.length > 0)) {
    return (
      <AccountPage width="narrow">
        <div className={`${ACCOUNT_PANEL} space-y-4 p-6 sm:p-8`}>
          <h1 className="text-balance font-brand-display text-brand-d2 text-brand-ink">
            {created ? t('readyTitle') : t('alreadyTitle')}
          </h1>
          <p className="text-brand-ui text-brand-ink-2">{t('consoleSameAccount')}</p>
          {/*
            A phone-only organizer has no email for organizer messages - approval, payouts - to
            reach. Asked here, proved by a code, never a password; skippable.
          */}
          {user && !user.email ? <OrganizerEmailStep /> : null}
          {/* A plain anchor, not next/link: this leaves the app for a different origin. The
            click carries THIS session across with a one-time code (lib/organizer-console.ts);
            the href is the console's own sign-in, for a new tab or no script. */}
          <a
            href={consoleHref}
            data-testid="open-organizer-console"
            aria-busy={opening || undefined}
            className={`${brandButtonClasses('primary', 'md')} w-full`}
            onClick={(e) => {
              if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return;
              e.preventDefault();
              setOpening(true);
              void openOrganizerConsole();
            }}
          >
            {t('openConsole')}
          </a>
          {created ? <p className="text-brand-meta text-brand-ink-2">{t('reviewNote')}</p> : null}
        </div>
      </AccountPage>
    );
  }

  return (
    <AccountPage width="narrow">
      <div className={`${ACCOUNT_PANEL} space-y-5 p-6 sm:p-8`}>
        <div>
          <h1 className="text-balance font-brand-display text-brand-d2 text-brand-ink">
            {t('heading')}
          </h1>
          <p className="mt-2 text-brand-ui text-brand-ink-2">{t('lead')}</p>
        </div>

        <form
          className="space-y-4"
          onSubmit={(e) => {
            e.preventDefault();
            setError(null);
            create.mutate();
          }}
        >
          <BrandTextField
            id="org-name"
            label={t('orgName')}
            autoFocus
            value={name}
            onChange={(e) => setName(e.target.value)}
            minLength={2}
            required
          />
          <BrandTextField
            id="org-contact"
            label={t('supportEmail')}
            type="email"
            placeholder={user?.email ?? ''}
            value={contactEmail}
            onChange={(e) => setContactEmail(e.target.value)}
          />

          {/* Country first: it decides the legal forms offered below it. */}
          <BrandSelectField
            id="org-country"
            label={t('country')}
            hint={t('countryHint')}
            value={country}
            onChange={(e) => {
              setCountry(e.target.value);
              // A legal form belongs to a country; keeping the old one would carry "Pvt Ltd"
              // onto a Canadian registration.
              setEntityType('');
            }}
          >
            <option value="">{t('countryPlaceholder')}</option>
            {MARKETS.map((m) => (
              <option key={m.code} value={m.name}>
                {m.name}
              </option>
            ))}
          </BrandSelectField>

          <BrandSelectField
            id="org-entity"
            label={t('entityType')}
            hint={t('entityTypeHint')}
            value={entityType}
            disabled={entityTypes.length === 0}
            onChange={(e) => setEntityType(e.target.value)}
          >
            <option value="">
              {country ? t('entityTypePlaceholder') : t('entityTypeNeedsCountry')}
            </option>
            {entityTypes.map((form) => (
              <option key={form} value={form}>
                {form}
              </option>
            ))}
          </BrandSelectField>

          <BrandTextField
            id="org-legal-name"
            label={t('legalName')}
            hint={t('legalNameHint')}
            value={legalName}
            onChange={(e) => setLegalName(e.target.value)}
            required
          />

          {error ? (
            <p role="alert" className="text-brand-meta text-brand-critical">
              {error}
            </p>
          ) : null}

          <BrandButton
            type="submit"
            className="w-full"
            aria-busy={create.isPending || undefined}
            disabled={
              create.isPending ||
              name.trim().length < 2 ||
              legalName.trim().length < 2 ||
              !country ||
              !entityType
            }
          >
            {t('create')}
          </BrandButton>
        </form>

        <p className="text-brand-meta text-brand-ink-2">
          {t('changedMind')}{' '}
          <Link href="/account" className={BRAND_LINK}>
            {t('backToAccount')}
          </Link>
        </p>
      </div>
    </AccountPage>
  );
}
