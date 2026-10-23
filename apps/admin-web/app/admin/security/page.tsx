'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import {
  api,
  Button,
  Card,
  Dialog,
  errorMessage,
  ErrorState,
  PageHeader,
  Skeleton,
  tokenStore,
  useAuthUser,
  useToast,
} from '@eticketsgo/web-kit';
import { RecoveryCodes } from '@/components/recovery-codes';

/**
 * Your own sign-in security: is the second step on, how many recovery codes are left, and the
 * two things you may do about it - make a new set of codes, or replace the phone.
 *
 * Both need a fresh authenticator code (the confirmation dialog appears by itself).
 */
export default function SecurityPage() {
  const qc = useQueryClient();
  const router = useRouter();
  const toast = useToast();
  // Whether this server can hold an authenticator at all (no MFA_ENCRYPTION_KEY: it cannot).
  const { user } = useAuthUser();
  const canEnroll = user?.mfa?.stepUp === 'available';
  const [codes, setCodes] = useState<string[] | null>(null);
  const [replacing, setReplacing] = useState(false);

  const status = useQuery({
    queryKey: ['auth', 'mfa-status'],
    queryFn: () => api.auth.mfaStatus(),
  });

  const regenerate = useMutation({
    mutationFn: () => api.auth.mfaRegenerateCodes(),
    onSuccess: (r) => {
      setCodes(r.recoveryCodes);
      qc.invalidateQueries({ queryKey: ['auth', 'mfa-status'] });
    },
    onError: (e) => toast.push(errorMessage(e), 'error'),
  });

  const replace = useMutation({
    mutationFn: () => api.auth.mfaReplaceDevice(),
    onSuccess: () => {
      tokenStore.clear();
      qc.clear();
      router.replace('/login');
    },
    onError: (e) => toast.push(errorMessage(e), 'error'),
  });

  return (
    <div className="max-w-2xl">
      <PageHeader
        title="Account security"
        description="Your second sign-in step for the back office."
      />
      {status.isLoading ? (
        <Skeleton className="h-32 w-full" />
      ) : status.isError || !status.data ? (
        <ErrorState
          message="Could not load your security settings."
          onRetry={() => status.refetch()}
        />
      ) : !status.data.enrolled ? (
        <Card className="space-y-2">
          {canEnroll ? (
            <>
              <p className="text-[0.9375rem] text-text-primary">
                You have not set up two-step sign-in yet. You need it for refunds, payouts, payment
                settings and staff changes.
              </p>
              <Button size="sm" onClick={() => router.push('/enroll-mfa')}>
                Set up two-step sign-in
              </Button>
            </>
          ) : (
            <p className="text-[0.9375rem] text-text-primary">
              The second sign-in step is not turned on for this server.
            </p>
          )}
        </Card>
      ) : (
        <div className="space-y-4">
          <Card className="space-y-1">
            <h2 className="text-[1rem] font-semibold text-text-primary">Authenticator app</h2>
            <p className="text-[0.9375rem] text-text-muted">
              On since{' '}
              {status.data.enrolledAt
                ? new Date(status.data.enrolledAt).toLocaleDateString()
                : 'an unknown date'}
              .
            </p>
            <div className="pt-2">
              <Button variant="outline" size="sm" onClick={() => setReplacing(true)}>
                Replace my phone
              </Button>
            </div>
          </Card>

          <Card className="space-y-2">
            <h2 className="text-[1rem] font-semibold text-text-primary">Recovery codes</h2>
            <p className="text-[0.9375rem] text-text-muted">
              {status.data.recoveryCodesRemaining} of 10 codes left. A new set makes the old codes
              stop working.
            </p>
            {codes ? (
              <RecoveryCodes codes={codes} onDone={() => setCodes(null)} />
            ) : (
              <Button
                variant="outline"
                size="sm"
                loading={regenerate.isPending}
                onClick={() => regenerate.mutate()}
              >
                Make new recovery codes
              </Button>
            )}
          </Card>
        </div>
      )}

      <Dialog
        open={replacing}
        onClose={() => setReplacing(false)}
        title="Replace my phone"
        description="Use this when you have a new phone."
      >
        <div className="space-y-4">
          <p className="text-[0.9375rem] text-text-primary">
            This removes your current authenticator and signs you out everywhere. At your next
            sign-in you set up the new phone and get new recovery codes.
          </p>
          <div className="flex justify-end gap-2">
            <Button variant="outline" onClick={() => setReplacing(false)}>
              Cancel
            </Button>
            <Button loading={replace.isPending} onClick={() => replace.mutate()}>
              Remove and sign out
            </Button>
          </div>
        </div>
      </Dialog>
    </div>
  );
}
