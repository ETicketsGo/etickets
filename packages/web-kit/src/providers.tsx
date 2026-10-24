'use client';

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useState, type ReactNode } from 'react';
import { ToastProvider } from './components';
import { HumanCheckProvider, type HumanCheckLabels } from './human-check';

/**
 * Shared app providers: React Query + toasts + the human-check dialog.
 *
 * The human check is here so every app answers the API's HUMAN_CHECK_REQUIRED the same way:
 * the storefront, the organizer console and the admin console all sign in through
 * `/auth/login`. It loads nothing until the API asks for a check.
 */
export function WebProviders({
  children,
  humanCheckLabels,
  humanCheckLanguage,
}: {
  children: ReactNode;
  /** Translated dialog copy. Unset: English. */
  humanCheckLabels?: HumanCheckLabels;
  /** Turnstile's own language (e.g. `fr`). Unset: the browser's. */
  humanCheckLanguage?: string;
}) {
  const [client] = useState(
    () =>
      new QueryClient({
        defaultOptions: { queries: { retry: 1, refetchOnWindowFocus: false, staleTime: 15_000 } },
      }),
  );
  return (
    <QueryClientProvider client={client}>
      <ToastProvider>
        <HumanCheckProvider labels={humanCheckLabels} language={humanCheckLanguage}>
          {children}
        </HumanCheckProvider>
      </ToastProvider>
    </QueryClientProvider>
  );
}
