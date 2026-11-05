'use client';

import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api, ApiRequestError } from '@/lib/api';

/** Why this booking cannot be paid for right now, or null when it can. */
export type PaymentBlock = 'platform' | 'organizer' | null;

/**
 * Whether Pay can work, asked BEFORE the buyer presses it.
 *
 * The checkout used to find out only from a refused Pay, and then showed "Online payment is
 * being activated" beside a Pay button that stayed enabled. Now the page asks the API up front
 * (`/payments/availability`, the same gates Pay applies) and disables Pay with the reason.
 * A refusal from Pay itself still sets the same state, in case the answer changed in between.
 *
 * Two different reasons, said differently: the PLATFORM has no gateway for this currency yet,
 * or this ORGANIZER has not finished payment setup.
 */
export function usePaymentBlock(bookingId: string) {
  const [refused, setRefused] = useState<PaymentBlock>(null);
  const q = useQuery({
    queryKey: ['payment-availability', bookingId],
    queryFn: () => api.paymentAvailability(bookingId),
    staleTime: 30_000,
    retry: 1,
  });
  const asked: PaymentBlock =
    q.data && !q.data.available
      ? q.data.reason === 'organizer_not_onboarded'
        ? 'organizer'
        : q.data.reason === 'platform_not_configured'
          ? 'platform'
          : null
      : null;
  return {
    reason: refused ?? asked,
    /** True when the error was a "cannot take payments" refusal, now shown as state. */
    fromError(err: unknown): boolean {
      if (!(err instanceof ApiRequestError)) return false;
      if (err.code === 'PAYMENT_PROVIDER_UNAVAILABLE') setRefused('platform');
      else if (err.code === 'ORGANIZER_PAYMENTS_NOT_READY') setRefused('organizer');
      else return false;
      return true;
    },
  };
}
