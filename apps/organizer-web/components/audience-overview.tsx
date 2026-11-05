'use client';

import { MailCheck, Repeat, Users } from 'lucide-react';
import {
  Card,
  EmptyState,
  ErrorState,
  Skeleton,
  StatCard,
  dateOnly,
  type AudienceSummary,
} from '@eticketsgo/web-kit';

/**
 * The Audience & growth overview, drawn from the summary the API returns. Kept out of the page
 * file so its loading, empty, error and ready states can be rendered in a test.
 */
export function AudienceBody({
  state,
  data,
  forbidden = false,
  onRetry,
}: {
  state: 'loading' | 'error' | 'ready';
  data?: AudienceSummary;
  forbidden?: boolean;
  onRetry?: () => void;
}) {
  if (state === 'loading') {
    return (
      <div className="space-y-4" aria-busy="true" data-testid="audience-loading">
        <div className="grid gap-4 sm:grid-cols-3">
          <Skeleton className="h-28 w-full" />
          <Skeleton className="h-28 w-full" />
          <Skeleton className="h-28 w-full" />
        </div>
        <Skeleton className="h-64 w-full" />
      </div>
    );
  }
  if (state === 'error' || !data) {
    return (
      <ErrorState
        message={
          forbidden
            ? 'Only owners and managers can see audience figures.'
            : 'We could not load your audience figures. Please try again.'
        }
        onRetry={forbidden ? undefined : onRetry}
      />
    );
  }
  if (data.followers.total === 0) {
    return (
      <EmptyState
        icon={Users}
        tone="teal"
        title="No followers yet"
        hint="People can follow you from your public page and after they buy a ticket. Your counts show here when they do."
      />
    );
  }

  const weeks = data.growth.weekly;
  return (
    <div className="space-y-6" data-testid="audience-ready">
      <div className="grid gap-4 sm:grid-cols-3">
        <StatCard
          label="Followers"
          value={data.followers.total.toLocaleString()}
          hint={`${data.followers.new7d} new in 7 days, ${data.followers.new30d} in 30 days`}
          icon={Users}
          tile="teal"
        />
        <StatCard
          label="Email subscribers"
          value={data.eligibleSubscribers.toLocaleString()}
          hint="Followers who said yes to email from you"
          icon={MailCheck}
          tile="purple"
        />
        <StatCard
          label="Returning buyers"
          value={data.returningBuyers.toLocaleString()}
          hint="Account holders with 2 or more bookings with you"
          icon={Repeat}
          tile="amber"
        />
      </div>
      <p className="text-caption text-text-muted">
        Following is not permission to email. Only email subscribers can get email from you.
      </p>

      <Card>
        <div>
          <h2 className="font-semibold text-text-primary">Follower growth by week</h2>
          <p className="mt-1 text-caption text-text-muted">
            The last 12 weeks. Weeks start on Monday (UTC). People who stopped following are not
            counted.
          </p>
          <div className="mt-4 overflow-x-auto">
            <table className="w-full text-left text-ui">
              <thead className="text-caption text-text-secondary">
                <tr>
                  <th scope="col" className="py-2 pr-4 font-medium">
                    Week of
                  </th>
                  <th scope="col" className="py-2 pr-4 text-right font-medium">
                    New followers
                  </th>
                  <th scope="col" className="py-2 text-right font-medium">
                    Followers at week end
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {weeks.map((w) => (
                  <tr key={w.start}>
                    <td className="py-2 pr-4 text-text-primary">
                      {dateOnly(`${w.start}T00:00:00Z`)}
                    </td>
                    <td className="py-2 pr-4 text-right tabular-nums">{w.newFollowers}</td>
                    <td className="py-2 text-right tabular-nums">{w.followers}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      </Card>

      <Card>
        <div>
          <h2 className="font-semibold text-text-primary">Followers by city</h2>
          <p className="mt-1 text-caption text-text-muted">
            From the venues followers booked with you. To protect privacy, a city with fewer than{' '}
            {data.cities.threshold} followers is not shown.
          </p>
          {data.cities.buckets.length === 0 ? (
            <p className="mt-4 text-ui text-text-secondary" data-testid="audience-no-cities">
              No city has {data.cities.threshold} or more followers yet.
            </p>
          ) : (
            <ul className="mt-4 divide-y divide-border">
              {data.cities.buckets.map((b) => (
                <li
                  key={`${b.city}-${b.country ?? ''}`}
                  className="flex items-center justify-between py-2 text-ui"
                >
                  <span className="text-text-primary">
                    {b.city}
                    {b.country ? `, ${b.country}` : ''}
                  </span>
                  <span className="tabular-nums text-text-secondary">{b.followers}</span>
                </li>
              ))}
            </ul>
          )}
          {data.cities.hiddenBuckets > 0 && (
            <p className="mt-3 text-caption text-text-muted">
              {data.cities.hiddenBuckets} smaller{' '}
              {data.cities.hiddenBuckets === 1 ? 'city is' : 'cities are'} hidden.
            </p>
          )}
        </div>
      </Card>
    </div>
  );
}
