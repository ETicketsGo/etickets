'use client';

import { useState } from 'react';
import { api } from '@/lib/api';
import {
  BRAND_LEAD,
  BRAND_PAGE_TITLE,
  BrandActionButton,
  BrandCenteredPage,
  BrandFormPanel,
  BrandInput,
} from '@/components/brand-forms';
import { BRAND_LINK } from '@/components/booking-brand';
import { Link } from '@/i18n/navigation';
import { useTranslations } from 'next-intl';

/**
 * Asking for a password reset link.
 *
 * ── WHY THIS SAYS THE SAME THING EITHER WAY ────────────────────────────────────────
 * The confirmation is shown whether or not the address has an account, because the server
 * answers identically and this page must not undo that. A screen that said "no account
 * with that email" would turn the form into a way to discover who holds an account here —
 * and on a ticketing platform, who bought tickets to what.
 *
 * It reads as slightly evasive, and that is the cost. The person who actually owns the
 * address finds out in their inbox, which is the only place it belongs.
 */
export default function ForgotPasswordPage() {
  const a = useTranslations('storefront.auth');
  const [email, setEmail] = useState('');
  const [sent, setSent] = useState(false);
  const [loading, setLoading] = useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    try {
      await api.forgotPassword(email);
    } catch {
      /*
        Swallowed on purpose. A network failure and an unknown address must look the same
        from here, and the only alternative — showing an error — would leak the difference
        the server works to hide.
      */
    } finally {
      setLoading(false);
      setSent(true);
    }
  };

  return (
    <BrandCenteredPage>
      <BrandFormPanel className="space-y-5">
        <h1 className={BRAND_PAGE_TITLE}>{a('resetTitle')}</h1>

        {sent ? (
          <>
            <p role="status" className={BRAND_LEAD}>
              {a('resetSent')}
            </p>
            <Link href="/login" className={`inline-block text-brand-meta ${BRAND_LINK}`}>
              {a('backToSignIn')}
            </Link>
          </>
        ) : (
          <form onSubmit={submit} className="space-y-5">
            <p className={BRAND_LEAD}>{a('resetLead')}</p>
            <BrandInput
              id="email"
              label={a('email')}
              type="email"
              autoComplete="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              required
            />
            <BrandActionButton type="submit" size="lg" className="w-full" loading={loading}>
              {a('resetSend')}
            </BrandActionButton>
            <Link href="/login" className={`inline-block text-brand-meta ${BRAND_LINK}`}>
              {a('backToSignIn')}
            </Link>
          </form>
        )}
      </BrandFormPanel>
    </BrandCenteredPage>
  );
}
