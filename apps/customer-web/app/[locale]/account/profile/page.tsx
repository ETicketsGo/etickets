'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';
import { useRouter } from '@/i18n/navigation';
import { Button, Card, Input, Skeleton, errorMessage, useToast } from '@eticketsgo/web-kit';
import { ErrorState } from '@/components/ui';
import { api, tokenStore } from '@/lib/api';
import { useMounted } from '@/lib/use-mounted';

export default function ProfilePage() {
  const t = useTranslations('storefront.profile');
  const router = useRouter();
  const mounted = useMounted();
  const qc = useQueryClient();
  const toast = useToast();
  const [fullName, setFullName] = useState('');

  useEffect(() => {
    if (!tokenStore.access) router.push('/login?next=/account/profile');
  }, [router]);

  const me = useQuery({
    queryKey: ['me'],
    queryFn: () => api.me(),
    // Not `typeof window`: the server drew the form and the client's first render the skeleton,
    // a hydration mismatch. See useMounted.
    enabled: mounted && !!tokenStore.access,
  });

  useEffect(() => {
    if (me.data) setFullName(me.data.fullName);
  }, [me.data]);

  const save = useMutation({
    mutationFn: () => api.updateProfile(fullName),
    onSuccess: () => {
      toast.push(t('updated'), 'success');
      qc.invalidateQueries({ queryKey: ['me'] });
      qc.invalidateQueries({ queryKey: ['auth', 'me'] });
    },
    onError: (e) => toast.push(errorMessage(e), 'error'),
  });

  return (
    <div className="mx-auto max-w-lg space-y-8">
      <div>
        <h1 className="text-h2 font-bold tracking-tight text-text-primary">{t('heading')}</h1>
        <p className="mt-1.5 text-[0.9375rem] text-text-muted">{t('lead')}</p>
      </div>
      {me.isError ? (
        <ErrorState message={t('loadError')} onRetry={() => me.refetch()} />
      ) : !mounted || me.isLoading ? (
        <Skeleton className="h-48 w-full" />
      ) : (
        <Card>
          <div className="space-y-4">
            <Input
              id="name"
              label={t('fullName')}
              value={fullName}
              onChange={(e) => setFullName(e.target.value)}
            />
            <Input id="email" label={t('email')} value={me.data?.email ?? ''} disabled />
            <Button
              loading={save.isPending}
              disabled={fullName.trim().length < 2}
              onClick={() => save.mutate()}
            >
              {t('save')}
            </Button>
          </div>
        </Card>
      )}
    </div>
  );
}
