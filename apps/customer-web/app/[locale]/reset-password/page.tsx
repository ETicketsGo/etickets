'use client';

import { Suspense, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import { api, ApiRequestError } from '@/lib/api';
import { useRouter, Link } from '@/i18n/navigation';
import {
  BRAND_ALERT,
  BRAND_LEAD,
  BRAND_PAGE_TITLE,
  BrandActionButton,
  BrandCenteredPage,
  BrandFormPanel,
  BrandPasswordField,
} from '@/components/brand-forms';
import { BRAND_LINK } from '@/components/booking-brand';
import { useTranslations } from 'next-intl';
import { passwordAcceptable } from '@eticketsgo/web-kit';
import { usePasswordCopy } from '@/lib/use-password-copy';

/**
 * Setting a new password from a reset link.
 *
 * The token arrives in the query string, which is where an emailed link can carry it. It is
 * single-use and short-lived precisely because a URL is the least private place a credential
 * can live — it lands in browser history, and in whatever proxy sits between.
 */
function ResetForm() {
  const a = useTranslations('storefront.auth');
  const params = useSearchParams();
  const router = useRouter();
  const token = params.get('token') ?? '';

  const [password, setPassword] = useState('');
  const [passwordError, setPasswordError] = useState<string | null>(null);
  const passwordCopy = usePasswordCopy();
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setLoading(true);
    try {
      await api.resetPassword(token, password);
      /*
        Sent to sign in, not signed in automatically. Holding the link proves control of the
        mailbox, which is enough to SET a password — but the session should start from the
        password they just chose, and every previous session has just been destroyed.
      */
      router.push('/login?reset=1');
    } catch (err) {
      const reason =
        err instanceof ApiRequestError
          ? (err.details?.fields as Record<string, string[]> | undefined)?.password?.[0]
          : undefined;
      if (reason) {
        /*
          A refused PASSWORD is not a bad link. Saying "this link is no longer valid" for it
          would send somebody to request a new email for a link that still works.
        */
        setPasswordError(reason);
      } else {
        // One message for every refusal of the LINK, matching the server: telling an expired
        // link apart from a spent one tells somebody holding a stolen link whether to chase a
        // fresher one.
        setError(a('resetLinkBad'));
      }
      setLoading(false);
    }
  };

  if (!token) {
    return (
      <BrandCenteredPage>
        <BrandFormPanel className="space-y-4">
          <h1 className={BRAND_PAGE_TITLE}>{a('newPasswordTitle')}</h1>
          <p className={BRAND_LEAD}>{a('resetLinkBad')}</p>
          <Link href="/forgot-password" className={`inline-block text-brand-meta ${BRAND_LINK}`}>
            {a('forgotPassword')}
          </Link>
        </BrandFormPanel>
      </BrandCenteredPage>
    );
  }

  return (
    <BrandCenteredPage>
      <BrandFormPanel className="space-y-5">
        <h1 className={BRAND_PAGE_TITLE}>{a('newPasswordTitle')}</h1>
        <form onSubmit={submit} className="space-y-5">
          <BrandPasswordField
            id="password"
            value={password}
            onChange={(next) => {
              setPassword(next);
              if (passwordError) setPasswordError(null);
            }}
            copy={{ ...passwordCopy, label: a('newPassword') }}
            serverError={passwordError ?? undefined}
            required
          />
          {error && (
            <p role="alert" className={BRAND_ALERT}>
              {error}
            </p>
          )}
          <BrandActionButton
            type="submit"
            size="lg"
            className="w-full"
            loading={loading}
            disabled={!passwordAcceptable(password)}
          >
            {a('newPasswordSave')}
          </BrandActionButton>
        </form>
        <Link href="/login" className={`inline-block text-brand-meta ${BRAND_LINK}`}>
          {a('backToSignIn')}
        </Link>
      </BrandFormPanel>
    </BrandCenteredPage>
  );
}

export default function ResetPasswordPage() {
  return (
    <Suspense fallback={null}>
      <ResetForm />
    </Suspense>
  );
}
