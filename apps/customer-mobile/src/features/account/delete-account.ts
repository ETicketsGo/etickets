import { AxiosError } from 'axios';
import { apiClient } from '@/services/api-client';
import { tokenStore } from '@/services/secure-store';
import { clearAllTickets } from '@/services/ticket-cache';
import { queryClient } from '@/application/query-client';

export type DeleteAccountOutcome =
  { kind: 'deleted' } | { kind: 'blocked'; message: string } | { kind: 'failed'; message: string };

/**
 * Delete the signed-in account, then scrub the device.
 *
 * ── WHY 401 COUNTS AS SUCCESS ─────────────────────────────────────────────────────
 * The API revokes the session as part of the deletion, and the JWT strategy now checks
 * account status on every request. So a retry after a dropped response — the exact case
 * a mobile client hits on a flaky connection — comes back 401, not 200, because the
 * deletion already happened and the token is dead.
 *
 * Treating that 401 as a failure would leave someone staring at "couldn't delete your
 * account" for an account that no longer exists, with no way to try again. It is
 * treated as confirmation instead. The one case this could mask is a token that expired
 * for an unrelated reason at the same instant, and the outcome there is identical
 * anyway: signed out, local data gone.
 *
 * ── LOCAL CLEANUP IS UNCONDITIONAL ────────────────────────────────────────────────
 * Tokens, cached tickets and every query cache are cleared whenever the server says the
 * account is gone. Leaving a cached wallet on the device after deletion would mean the
 * app still showing someone's tickets and name after they asked for it all to be
 * removed — which is the deletion failing in the only place the user can see.
 */
export async function deleteAccount(reason?: string): Promise<DeleteAccountOutcome> {
  try {
    await apiClient.delete('/users/me', { data: reason ? { reason } : {} });
    await scrubDevice();
    return { kind: 'deleted' };
  } catch (error) {
    if (error instanceof AxiosError) {
      const status = error.response?.status;

      // Already deleted; the session died with it.
      if (status === 401) {
        await scrubDevice();
        return { kind: 'deleted' };
      }

      // A reason the user can act on — currently only "you are the sole owner of an
      // organization". Surfaced verbatim: the API's message names the fix.
      if (status === 409) {
        const body = error.response?.data as { message?: string } | undefined;
        return {
          kind: 'blocked',
          message:
            typeof body?.message === 'string'
              ? body.message
              : 'Your account cannot be deleted yet.',
        };
      }
    }

    return {
      kind: 'failed',
      message: "We couldn't delete your account. Check your connection and try again.",
    };
  }
}

/**
 * Remove every trace of the account from this device.
 *
 * Order matters: credentials first, so a failure part-way through cannot leave a usable
 * token beside emptied caches.
 */
async function scrubDevice(): Promise<void> {
  await tokenStore.clear();
  await clearAllTickets();
  // Cancels anything in flight as well as dropping cached responses — a background
  // refetch completing after this would repopulate the cache it just emptied.
  queryClient.cancelQueries();
  queryClient.clear();
}

/**
 * The phrase a user must type to confirm.
 *
 * Deliberately not a plain "are you sure?" — this is irreversible and takes their
 * booking history with it. Typing a specific word is the cheapest way to make the
 * action deliberate rather than a mis-tap, and it is what the platforms expect for
 * destructive account operations.
 */
export const DELETE_CONFIRMATION_PHRASE = 'DELETE';

export function isDeletionConfirmed(input: string): boolean {
  return input.trim().toUpperCase() === DELETE_CONFIRMATION_PHRASE;
}
