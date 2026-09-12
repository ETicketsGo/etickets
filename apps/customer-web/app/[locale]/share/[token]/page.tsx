'use client';

import { useMutation, useQuery } from '@tanstack/react-query';
import { useParams } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { useRouter } from '@/i18n/navigation';
import { CalendarDays, CheckCircle2, MapPin, ShieldCheck, Ticket } from 'lucide-react';
import { errorMessage } from '@eticketsgo/web-kit';
import { api, tokenStore } from '@/lib/api';
import { useFormat } from '@/lib/format';
import { Button, ButtonLink, Card, Skeleton } from '@/components/ui';

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
        <Skeleton className="h-72 w-full" />
      </Wrapper>
    );

  if (share.isError)
    return (
      <Wrapper>
        <Card className="text-center">
          <h1 className="text-h3 font-bold text-text-primary">{t('unavailableTitle')}</h1>
          <p className="mt-1.5 text-[0.9375rem] text-text-secondary">{errorMessage(share.error)}</p>
          <div className="mt-6">
            <ButtonLink href="/events" variant="outline">
              {w('browseEvents')}
            </ButtonLink>
          </div>
        </Card>
      </Wrapper>
    );

  const data = share.data!;
  const r = data.resource;
  const place =
    r.resourceType === 'TICKET' && r.cinemaName
      ? [r.cinemaName, r.screenName].filter(Boolean).join(' · ')
      : r.venueName;
  const fallback = shareQrFallback(w('qrUnavailable'));

  return (
    <Wrapper>
      <Card className="space-y-4">
        <div className="flex items-center justify-between">
          <span className="inline-flex items-center gap-1.5 rounded-full bg-background-subtle px-2.5 py-1 text-caption font-medium text-text-secondary">
            <Ticket className="h-3.5 w-3.5" />
            {t('sharedWithYou')}
          </span>
          <span className="inline-flex items-center gap-1.5 text-caption font-medium text-text-muted">
            <ShieldCheck className="h-3.5 w-3.5" />
            {data.permission === 'GUEST'
              ? t('permission.GUEST')
              : data.permission === 'TRANSFER'
                ? t('permission.TRANSFER')
                : t('permission.VIEW')}
          </span>
        </div>

        <div>
          <h1 className="text-h3 font-bold tracking-tight text-text-primary">{r.title}</h1>
          {r.subtitle && (
            <p className="mt-0.5 text-[0.9375rem] text-text-secondary">{r.subtitle}</p>
          )}
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
              className="h-52 w-52 rounded-2xl bg-white p-2 shadow-sm"
            />
            <p className="mt-2 text-caption text-text-muted">{t('showAtGate')}</p>
          </div>
        ) : (
          data.permission === 'VIEW' && (
            <div className="rounded-lg border border-dashed border-border p-6 text-center text-caption text-text-muted">
              {t('qrHidden')}
            </div>
          )
        )}

        <dl className="space-y-1.5 text-[0.9375rem] text-text-secondary">
          {r.seatLabel && (
            <Row label={t('seat')}>
              <span className="font-medium text-text-primary">{r.seatLabel}</span>
            </Row>
          )}
          {place && (
            <Row label={t('where')}>
              <span className="inline-flex items-center gap-1.5">
                <MapPin className="h-3.5 w-3.5 text-text-muted" /> {place}
              </span>
            </Row>
          )}
          {r.startsAt && (
            <Row label={t('when')}>
              <span className="inline-flex items-center gap-1.5">
                <CalendarDays className="h-3.5 w-3.5 text-text-muted" />{' '}
                {dateTime(r.startsAt, undefined, r.timeZone ?? undefined)}
              </span>
            </Row>
          )}
          {r.reference && (
            <Row label={t('reference')}>
              <span className="font-mono text-caption">{r.reference}</span>
            </Row>
          )}
        </dl>

        {data.canTransfer && (
          <div className="rounded-lg border border-border bg-background-subtle/50 p-4">
            <p className="flex items-center gap-1.5 font-medium text-text-primary">
              <CheckCircle2 className="h-4 w-4 text-status-success" /> {t('takeOwnership')}
            </p>
            <p className="mt-1 text-caption text-text-muted">{t('acceptHint')}</p>
            {accept.isError && (
              <p role="alert" className="mt-2 text-caption text-status-error">
                {errorMessage(accept.error)}
              </p>
            )}
            <Button
              className="mt-3 w-full"
              loading={accept.isPending}
              onClick={() =>
                tokenStore.access
                  ? accept.mutate()
                  : router.push(`/login?next=${encodeURIComponent(`/share/${token}`)}`)
              }
            >
              {tokenStore.access ? t('accept') : t('signInToAccept')}
            </Button>
          </div>
        )}
      </Card>
    </Wrapper>
  );
}

function Wrapper({ children }: { children: React.ReactNode }) {
  return <div className="mx-auto max-w-md py-8">{children}</div>;
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-baseline justify-between gap-4">
      <dt className="text-caption uppercase tracking-wide text-text-muted">{label}</dt>
      <dd className="min-w-0 truncate">{children}</dd>
    </div>
  );
}
