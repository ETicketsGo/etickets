'use client';

import { useMutation, useQuery } from '@tanstack/react-query';
import { useParams } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { CheckCircle2, MailX } from 'lucide-react';
import { brandButtonClasses } from '@eticketsgo/web-kit';
import { api, type UnsubscribePreview } from '@/lib/api';
import { Link } from '@/i18n/navigation';
import { BrandPage } from '@/components/storefront-brand';
import {
  BRAND_LEAD,
  BRAND_NOTE,
  BRAND_PAGE_TITLE,
  BrandActionButton,
  BrandFormPanel,
  BrandSkeleton,
} from '@/components/brand-forms';

/**
 * The page behind the unsubscribe link in an email.
 *
 * ── WHY ONE CLICK AND NOT ZERO ─────────────────────────────────────────────────────
 * Opening the page changes nothing. Mail scanners and link previewers open every link in a
 * message, and a page that unsubscribed on load would unsubscribe people from mail they
 * wanted. So the page says exactly what will stop, and one button does it. Mail apps that
 * support it unsubscribe without this page at all (RFC 8058, a POST to the API).
 *
 * No sign-in: the link is signed, and the signature is the authority. The address is shown
 * masked, because a forwarded email forwards this link too.
 */
export default function UnsubscribePage() {
  const t = useTranslations('storefront.unsubscribe');
  const { token } = useParams<{ token: string }>();

  const preview = useQuery({
    queryKey: ['unsubscribe', token],
    queryFn: () => api.unsubscribePreview(token),
    retry: false,
  });
  const confirm = useMutation({ mutationFn: () => api.unsubscribeConfirm(token) });

  const what = (p: UnsubscribePreview) =>
    p.scope === 'organizer' && p.organization
      ? t('whatOrganizer', { name: p.organization.name })
      : t('whatPlatform');

  if (preview.isLoading) {
    return (
      <Centered>
        <BrandSkeleton className="h-56 w-full" />
      </Centered>
    );
  }

  if (preview.isError || !preview.data) {
    return (
      <Centered>
        <BrandFormPanel className="text-center">
          <h1 className={BRAND_PAGE_TITLE} data-testid="unsubscribe-invalid">
            {t('invalidTitle')}
          </h1>
          <p className={`mt-2 ${BRAND_LEAD}`}>{t('invalidLead')}</p>
          <div className="mt-6">
            <Link
              href="/account/notification-settings"
              className={brandButtonClasses('secondary', 'lg')}
            >
              {t('openSettings')}
            </Link>
          </div>
        </BrandFormPanel>
      </Centered>
    );
  }

  const data = preview.data;

  if (confirm.isSuccess) {
    return (
      <Centered>
        <BrandFormPanel className="space-y-4 text-center">
          <CheckCircle2 className="mx-auto h-10 w-10 text-brand-positive" aria-hidden />
          <h1 className={BRAND_PAGE_TITLE} data-testid="unsubscribe-done">
            {t('doneTitle')}
          </h1>
          <p className={BRAND_LEAD}>{t('doneLead', { what: what(data), email: data.emailMask })}</p>
          <p className={BRAND_NOTE}>{t('ticketsStillCome')}</p>
          <p className={BRAND_NOTE}>{t('changedMind')}</p>
          <div>
            <Link
              href="/account/notification-settings"
              className={brandButtonClasses('secondary', 'lg')}
            >
              {t('openSettings')}
            </Link>
          </div>
        </BrandFormPanel>
      </Centered>
    );
  }

  return (
    <Centered>
      <BrandFormPanel className="space-y-4">
        <MailX className="h-8 w-8 text-brand-ink-2" aria-hidden />
        <h1 className={BRAND_PAGE_TITLE}>{t('title')}</h1>
        <p className={BRAND_LEAD} data-testid="unsubscribe-what">
          {t('lead', { what: what(data), email: data.emailMask })}
        </p>
        <p className={BRAND_NOTE}>{t('ticketsStillCome')}</p>
        {confirm.isError && (
          <p className="text-brand-meta font-medium text-brand-critical" role="alert">
            {t('error')}
          </p>
        )}
        <BrandActionButton
          size="lg"
          className="w-full"
          loading={confirm.isPending}
          onClick={() => confirm.mutate()}
        >
          {t('confirm')}
        </BrandActionButton>
      </BrandFormPanel>
    </Centered>
  );
}

/** One panel, centred, on the brand paper. The same column as sign-in. */
function Centered({ children }: { children: React.ReactNode }) {
  return (
    <BrandPage>
      <div className="mx-auto max-w-md px-4 pt-8 sm:px-6 sm:pt-12">{children}</div>
    </BrandPage>
  );
}
