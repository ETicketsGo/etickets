'use client';

import { useEffect, useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useTranslations } from 'next-intl';
import { useToast } from '@eticketsgo/web-kit';
import { api, type FollowPreferences as Prefs } from '@/lib/api';
import { BrandToggle } from '@/components/account-brand';

export const followPreferencesKey = (organizationId: string) =>
  ['follow-preferences', organizationId] as const;

type PreferenceChange = Partial<Omit<Prefs, 'organizationId'>>;

/**
 * What a follower hears from one organizer: the in-account notice, the three organizer
 * emails, and how often.
 *
 * Shared by the Following page and the dialog the Follow button opens, so both save the same
 * way:
 *   - each change saves at once, with only the key that changed;
 *   - the switch moves at once, and moves BACK if the API refuses;
 *   - "Saved" is said only after the API answers yes; a refusal says so;
 *   - every control is disabled while a save is in flight.
 *
 * `feedback` says where the result is reported. The Following page uses toasts, as it always
 * has. Inside a modal dialog a toast sits outside the dialog, where a screen reader is not
 * looking, so the dialog asks for an inline status line instead.
 *
 * The defaults come from the server and are not changed here: the in-account notice is on,
 * every email is off until the person turns it on.
 */
export function FollowPreferences({
  organizationId,
  initial,
  feedback = 'toast',
}: {
  organizationId: string;
  initial: Prefs;
  feedback?: 'toast' | 'inline';
}) {
  const t = useTranslations('storefront.following');
  const qc = useQueryClient();
  const toast = useToast();
  const [prefs, setPrefs] = useState(initial);
  const [status, setStatus] = useState<'saved' | 'error' | null>(null);
  useEffect(() => setPrefs(initial), [initial]);

  const save = useMutation({
    mutationFn: (body: PreferenceChange) => api.setFollowPreferences(organizationId, body),
    onMutate: (body) => {
      const before = prefs;
      setStatus(null);
      setPrefs({ ...prefs, ...body });
      return { before };
    },
    onSuccess: (next) => {
      setPrefs(next);
      if (feedback === 'inline') setStatus('saved');
      else toast.push(t('saved'), 'success');
      qc.setQueryData(followPreferencesKey(organizationId), next);
      qc.invalidateQueries({ queryKey: ['following'] });
      qc.invalidateQueries({ queryKey: ['communication-consent'] });
    },
    onError: (_e, _body, context) => {
      if (context?.before) setPrefs(context.before);
      if (feedback === 'inline') setStatus('error');
      else toast.push(t('saveError'), 'error');
    },
  });

  const row = (
    key: 'newEvents' | 'emailUpdates' | 'earlyAccess' | 'offers',
    label: string,
    hint: string,
  ) => (
    <li className="flex items-start justify-between gap-4 py-3 first:pt-0 last:pb-0">
      <span>
        <span className="block text-brand-ui font-medium text-brand-ink">{label}</span>
        <span className="block text-brand-meta text-brand-ink-2">{hint}</span>
      </span>
      <BrandToggle
        checked={prefs[key]}
        disabled={save.isPending}
        aria-label={label}
        onChange={(value) => save.mutate({ [key]: value })}
      />
    </li>
  );

  return (
    <div className="space-y-4" data-testid="follow-preferences">
      <ul className="divide-y divide-brand-line">
        {row('newEvents', t('prefNewEvents'), t('prefNewEventsHint'))}
        {row('emailUpdates', t('prefEmailUpdates'), t('prefEmailUpdatesHint'))}
        {row('earlyAccess', t('prefEarlyAccess'), t('prefEarlyAccessHint'))}
        {row('offers', t('prefOffers'), t('prefOffersHint'))}
      </ul>
      <fieldset>
        <legend className="text-brand-ui font-medium text-brand-ink">{t('cadenceLabel')}</legend>
        <div className="mt-2 flex flex-wrap gap-x-6 gap-y-2">
          {(['INSTANT', 'WEEKLY_DIGEST'] as const).map((cadence) => (
            <label
              key={cadence}
              className="inline-flex min-h-11 items-center gap-2 text-brand-ui text-brand-ink"
            >
              <input
                type="radio"
                name={`cadence-${organizationId}`}
                value={cadence}
                checked={prefs.cadence === cadence}
                disabled={save.isPending}
                onChange={() => save.mutate({ cadence })}
                className="h-4 w-4 accent-brand-action"
              />
              {cadence === 'INSTANT' ? t('cadenceInstant') : t('cadenceWeekly')}
            </label>
          ))}
        </div>
      </fieldset>
      <p className="text-brand-meta text-brand-ink-3">{t('consentNote')}</p>
      {feedback === 'inline' && (
        <p
          role="status"
          aria-live="polite"
          data-testid="follow-preferences-status"
          className={`min-h-5 text-brand-meta ${
            status === 'error' ? 'text-brand-critical' : 'text-brand-ink-2'
          }`}
        >
          {status === 'saved' ? t('saved') : status === 'error' ? t('saveError') : ''}
        </p>
      )}
    </div>
  );
}
