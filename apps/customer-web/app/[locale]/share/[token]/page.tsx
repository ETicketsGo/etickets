'use client';

import { useMutation, useQuery } from '@tanstack/react-query';
import { useParams } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { useRouter } from '@/i18n/navigation';
import { CalendarDays, CheckCircle2, MapPin, ShieldCheck, Ticket } from 'lucide-react';
import { errorMessage } from '@eticketsgo/web-kit';
import { api, tokenStore } from '@/lib/api';
import { useFormat } from '@/lib/format';
import { brandButtonClasses } from '@eticketsgo/web-kit';
import { Link } from '@/i18n/navigation';
import {
  BRAND_ALERT,
  BRAND_INSET,
  BRAND_LEAD,
  BRAND_NOTE,
  BRAND_PAGE_TITLE,
  BrandActionButton,
  BrandCenteredPage,
  BrandFormPanel,
  BrandSkeleton,
} from '@/components/brand-forms';
import { BRAND_EYEBROW } from '@/components/booking-brand';

/** The placeholder drawn when a QR image fails, in the reader's language. */
function shareQrFallback(text: string): string {
  const safe = text.replace(/[&<>]/g, (c) => (c === '&' ? '&amp;' : c === '<' ? '&lt;' : '&gt;'));
  return (
    'data:image/svg+xml;utf8,' +
    encodeURIComponent(
      `<svg xmlns="http://www.w3.org/2000/svg" width="200" height="200"><rect width="200" height="200" fill="#f1f5f9"/><text x="100" y="104" font-family="sans-serif" font-size="12" fill="#94a3b8" text-anchor="middle">${safe}</text></svg>`,
    )
  );
}

/**
 * Public recipient view for a share link. No login needed for view/guest; the
 * server returns a permission-scoped payload (live QR only for guest access).
 * A transfer link offers "Accept ownership", which requires sign-in.
 */
export default function SharePage() {
  const t = useTranslations('storefront.sharedTicket');
  const w = useTranslations('storefront.wallet');
  const { dateTime } = useFormat();
  const { token } = useParams<{ token: string }>();
  const router = useRouter();

  const share = useQuery({
    queryKey: ['share', token],
    queryFn: () => api.resolveShare(token),
    retry: false,
  });

  const accept = useMutation({
    mutationFn: () => api.acceptInvite(token),
    onSuccess: () => router.push('/account/tickets'),
  });

  if (share.isLoading)
    return (
      <Wrapper>
        <BrandSkeleton className="h-72 w-full" />
      </Wrapper>
    );

  if (share.isError)
    return (
      <Wrapper>
        <BrandFormPanel className="text-center">
          <h1 className={BRAND_PAGE_TITLE}>{t('unavailableTitle')}</h1>
          <p className={`mt-2 ${BRAND_LEAD}`}>{errorMessage(share.error)}</p>
          <div className="mt-6">
            <Link href="/events" className={brandButtonClasses('secondary', 'lg')}>
              {w('browseEvents')}
            </Link>
          </div>
        </BrandFormPanel>
      </Wrapper>
    );

  const data = share.data!;
  const r = data.resource;
  const place =
    r.resourceType === 'TICKET' && r.cinemaName
      ? [r.cinemaName, r.screenName].filter(Boolean).join(' - ')
      : r.venueName;
  const fallback = shareQrFallback(w('qrUnavailable'));

  return (
    <Wrapper>
      <BrandFormPanel className="space-y-5">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <span className="inline-flex h-6 items-center gap-1.5 rounded-full bg-brand-sunken px-2.5 text-brand-meta font-semibold text-brand-ink-2">
            <Ticket className="h-3.5 w-3.5" aria-hidden />
            {t('sharedWithYou')}
          </span>
          <span className="inline-flex items-center gap-1.5 text-brand-meta font-medium text-brand-ink-3">
            <ShieldCheck className="h-3.5 w-3.5" />
            {data.permission === 'GUEST'
              ? t('permission.GUEST')
              : data.permission === 'TRANSFER'
                ? t('permission.TRANSFER')
                : t('permission.VIEW')}
          </span>
        </div>

        <div>
          <h1 className={BRAND_PAGE_TITLE}>{r.title}</h1>
          {r.subtitle && <p className={`mt-1 ${BRAND_LEAD}`}>{r.subtitle}</p>}
        </div>

        {/* Guest access shows the single live QR */}
        {data.qrDataUrl ? (
          <div className="flex flex-col items-center">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={data.qrDataUrl}
              alt={t('qrAlt')}
              onError={(e) => {
                const img = e.currentTarget;
                if (img.src !== fallback) img.src = fallback;
              }}
              className="h-52 w-52 rounded-brand-card border border-brand-line bg-white p-2"
            />
            <p className={`mt-2 ${BRAND_NOTE}`}>{t('showAtGate')}</p>
          </div>
        ) : (
          data.permission === 'VIEW' && (
            <div className={`${BRAND_INSET} text-center text-brand-meta text-brand-ink-2`}>
              {t('qrHidden')}
            </div>
          )
        )}

        <dl className="space-y-2 border-t border-brand-line pt-4 text-brand-ui text-brand-ink-2">
          {r.seatLabel && (
            <Row label={t('seat')}>
              <span className="font-semibold text-brand-ink">{r.seatLabel}</span>
            </Row>
          )}
          {place && (
            <Row label={t('where')}>
              <span className="inline-flex items-center gap-1.5">
                <MapPin className="h-3.5 w-3.5 text-brand-ink-3" aria-hidden /> {place}
              </span>
            </Row>
          )}
          {r.startsAt && (
            <Row label={t('when')}>
              <span className="inline-flex items-center gap-1.5">
                <CalendarDays className="h-3.5 w-3.5 text-brand-ink-3" aria-hidden />{' '}
                {dateTime(r.startsAt, undefined, r.timeZone ?? undefined)}
              </span>
            </Row>
          )}
          {r.reference && (
            <Row label={t('reference')}>
              <span className="font-mono text-brand-meta text-brand-ink">{r.reference}</span>
            </Row>
          )}
        </dl>

        {data.canTransfer && (
          <div className={BRAND_INSET}>
            <p className="flex items-center gap-1.5 text-brand-ui font-semibold text-brand-ink">
              <CheckCircle2 className="h-4 w-4 text-brand-positive" aria-hidden />{' '}
              {t('takeOwnership')}
            </p>
            <p className={`mt-1 ${BRAND_NOTE}`}>{t('acceptHint')}</p>
            {accept.isError && (
              <p role="alert" className={`mt-2 ${BRAND_ALERT}`}>
                {errorMessage(accept.error)}
              </p>
            )}
            <BrandActionButton
              size="lg"
              className="mt-3 w-full"
              loading={accept.isPending}
              onClick={() =>
                tokenStore.access
                  ? accept.mutate()
                  : router.push(`/login?next=${encodeURIComponent(`/share/${token}`)}`)
              }
            >
              {tokenStore.access ? t('accept') : t('signInToAccept')}
            </BrandActionButton>
          </div>
        )}
      </BrandFormPanel>
    </Wrapper>
  );
}

function Wrapper({ children }: { children: React.ReactNode }) {
  return <BrandCenteredPage>{children}</BrandCenteredPage>;
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-baseline justify-between gap-4">
      <dt className={BRAND_EYEBROW}>{label}</dt>
      <dd className="min-w-0 truncate">{children}</dd>
    </div>
  );
}
