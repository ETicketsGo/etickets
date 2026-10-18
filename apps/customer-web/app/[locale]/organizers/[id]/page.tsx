'use client';

import { useQuery } from '@tanstack/react-query';
import { useParams } from 'next/navigation';
import { useEffect, useState } from 'react';
import { BadgeCheck, CalendarDays, Globe, Mail, Phone } from 'lucide-react';
import { apiAssetUrl, BrandButton, useToast } from '@eticketsgo/web-kit';
import { api } from '@/lib/api';
import { useFormat } from '@/lib/format';
import { EventTile } from '@/components/home/parts';
import { BRAND_WRAP, BrandEmpty, BrandPage } from '@/components/storefront-brand';
import { MK_LINK, MK_PRIMARY } from '@/components/marketing/kit';

const FOLLOW_KEY = 'etg_following';

export default function OrganizerProfilePage() {
  const { dateOnly } = useFormat();
  const { id } = useParams<{ id: string }>();
  const toast = useToast();
  const [following, setFollowing] = useState(false);

  const {
    data: org,
    isLoading,
    isError,
    refetch,
  } = useQuery({
    queryKey: ['organizer', id],
    queryFn: () => api.organizerProfile(id),
  });

  useEffect(() => {
    try {
      const list = JSON.parse(localStorage.getItem(FOLLOW_KEY) ?? '[]') as string[];
      setFollowing(list.includes(id));
    } catch {
      /* ignore */
    }
  }, [id]);

  const toggleFollow = () => {
    try {
      const list = JSON.parse(localStorage.getItem(FOLLOW_KEY) ?? '[]') as string[];
      const next = list.includes(id) ? list.filter((x) => x !== id) : [...list, id];
      localStorage.setItem(FOLLOW_KEY, JSON.stringify(next));
      const nowFollowing = next.includes(id);
      setFollowing(nowFollowing);
      toast.push(nowFollowing ? 'Following' : 'Unfollowed', 'success');
    } catch {
      /* ignore */
    }
  };

  if (isError)
    return (
      <BrandPage>
        <div className={`${BRAND_WRAP} pt-8 lg:pt-14`}>
          <BrandEmpty
            title="We couldn't load this organizer. Please try again."
            action={
              <button type="button" onClick={() => refetch()} className={MK_PRIMARY}>
                Try again
              </button>
            }
          />
        </div>
      </BrandPage>
    );
  if (isLoading || !org)
    return (
      <BrandPage>
        <div className={`${BRAND_WRAP} pt-8 lg:pt-14`} aria-busy="true">
          <div className="h-64 w-full animate-pulse rounded-brand-card bg-brand-sunken" />
        </div>
      </BrandPage>
    );

  const socials = [
    { href: org.website, label: 'Website', icon: Globe },
    { href: org.twitterUrl, label: 'X', icon: Globe },
    { href: org.instagramUrl, label: 'Instagram', icon: Globe },
    { href: org.facebookUrl, label: 'Facebook', icon: Globe },
  ].filter((s): s is { href: string; label: string; icon: typeof Globe } => Boolean(s.href));

  return (
    <BrandPage>
      <div className={`${BRAND_WRAP} space-y-10 pt-8 lg:pt-14`}>
        {/* Profile header */}
        <div className="overflow-hidden rounded-brand-card border border-brand-line bg-brand-surface">
          {apiAssetUrl(org.coverImageUrl) ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              /*
              Through `apiAssetUrl`, because these are now paths on the API rather than
              somebody else's absolute URL. It passes an absolute URL through untouched, so
              an organizer who pasted a link years ago still renders.
            */
              src={apiAssetUrl(org.coverImageUrl)!}
              alt=""
              className="h-40 w-full object-cover"
            />
          ) : (
            <div data-brand-tone="stage" className="h-28 bg-brand-canvas" />
          )}
          <div className="flex flex-col items-start gap-4 p-6 sm:flex-row sm:items-end sm:justify-between">
            <div className="flex items-end gap-4">
              {apiAssetUrl(org.logoUrl) ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img
                  src={apiAssetUrl(org.logoUrl)!}
                  alt={`${org.name} logo`}
                  className="-mt-12 h-20 w-20 rounded-brand-card border-4 border-brand-surface object-cover"
                />
              ) : (
                <div className="-mt-12 flex h-20 w-20 items-center justify-center rounded-brand-card border-4 border-brand-surface bg-brand-action font-brand-display text-brand-d3 text-brand-on-action">
                  {org.name.charAt(0)}
                </div>
              )}
              <div>
                <div className="flex items-center gap-2">
                  <h1 className="font-brand-display text-brand-d2 text-brand-ink">{org.name}</h1>
                  {org.verified && (
                    <span
                      className="inline-flex items-center gap-1 rounded-full bg-brand-info-tint px-2 py-0.5 text-brand-meta font-medium text-brand-info"
                      title="Verified organizer"
                    >
                      <BadgeCheck className="h-3.5 w-3.5" /> Verified
                    </span>
                  )}
                </div>
                <p className="mt-1 flex items-center gap-1.5 text-brand-meta text-brand-ink-2">
                  <CalendarDays className="h-3.5 w-3.5" />
                  Organizer since {dateOnly(org.memberSince)} · {org.eventCount} live event
                  {org.eventCount === 1 ? '' : 's'}
                </p>
              </div>
            </div>
            <BrandButton
              variant={following ? 'secondary' : 'primary'}
              onClick={toggleFollow}
              aria-pressed={following}
            >
              {following ? 'Following' : 'Follow'}
            </BrandButton>
          </div>
          {(org.description || socials.length > 0 || org.contactEmail || org.contactPhone) && (
            <div className="space-y-3 border-t border-brand-line px-6 py-5">
              {org.description && (
                <p className="max-w-2xl whitespace-pre-line text-brand-body text-brand-ink-2">
                  {org.description}
                </p>
              )}
              <div className="flex flex-wrap gap-x-4 gap-y-2 text-brand-meta">
                {socials.map((s) => (
                  <a
                    key={s.label}
                    href={s.href}
                    target="_blank"
                    rel="noopener noreferrer"
                    className={`inline-flex items-center gap-1.5 ${MK_LINK}`}
                  >
                    <s.icon className="h-3.5 w-3.5" /> {s.label}
                  </a>
                ))}
                {org.contactEmail && (
                  <a
                    href={`mailto:${org.contactEmail}`}
                    className={`inline-flex items-center gap-1.5 ${MK_LINK}`}
                  >
                    <Mail className="h-3.5 w-3.5" /> {org.contactEmail}
                  </a>
                )}
                {org.contactPhone && (
                  <span className="inline-flex items-center gap-1.5 text-brand-ink-2">
                    <Phone className="h-3.5 w-3.5" /> {org.contactPhone}
                  </span>
                )}
              </div>
            </div>
          )}
        </div>

        {/* Their events */}
        <section className="space-y-5">
          <h2 className="font-brand-display text-brand-d3 text-brand-ink">Events by {org.name}</h2>
          {org.events.length > 0 ? (
            <div className="grid gap-x-6 gap-y-10 sm:grid-cols-2 lg:grid-cols-3">
              {org.events.map((e) => (
                <EventTile key={e.id} event={e} />
              ))}
            </div>
          ) : (
            <BrandEmpty
              title="No live events right now"
              hint="Follow to hear when new events go on sale."
            />
          )}
        </section>
      </div>
    </BrandPage>
  );
}
