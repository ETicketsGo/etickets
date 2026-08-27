'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { useRouter } from '@/i18n/navigation';
import {
  Button,
  Card,
  ErrorState,
  Input,
  Skeleton,
  errorMessage,
  useToast,
} from '@eticketsgo/web-kit';
import { api, tokenStore } from '@/lib/api';

export default function ProfilePage() {
  const router = useRouter();
  const qc = useQueryClient();
  const toast = useToast();
  const [fullName, setFullName] = useState('');

  useEffect(() => {
    if (!tokenStore.access) router.push('/login?next=/account/profile');
  }, [router]);

  const me = useQuery({
    queryKey: ['me'],
    queryFn: () => api.me(),
    enabled: typeof window !== 'undefined' && !!tokenStore.access,
  });

  useEffect(() => {
    if (me.data) setFullName(me.data.fullName);
  }, [me.data]);

  const save = useMutation({
    mutationFn: () => api.updateProfile(fullName),
    onSuccess: () => {
      toast.push('Profile updated.', 'success');
      qc.invalidateQueries({ queryKey: ['me'] });
      qc.invalidateQueries({ queryKey: ['auth', 'me'] });
    },
    onError: (e) => toast.push(errorMessage(e), 'error'),
  });

  return (
    <div className="mx-auto max-w-lg space-y-8">
      <div>
        <h1 className="text-h2 font-bold tracking-tight text-text-primary">Profile</h1>
        <p className="mt-1.5 text-[0.9375rem] text-text-muted">Manage your account details.</p>
      </div>
      {me.isError ? (
        <ErrorState
          message="We couldn't load your profile. Please try again."
          onRetry={() => me.refetch()}
        />
      ) : me.isLoading ? (
        <Skeleton className="h-48 w-full" />
      ) : (
        <Card>
          <div className="space-y-4">
            <Input
              id="name"
              label="Full name"
              value={fullName}
              onChange={(e) => setFullName(e.target.value)}
            />
            <Input id="email" label="Email" value={me.data?.email ?? ''} disabled />
            <Button
              loading={save.isPending}
              disabled={fullName.trim().length < 2}
              onClick={() => save.mutate()}
            >
              Save changes
            </Button>
          </div>
        </Card>
      )}
    </div>
  );
}
