import { AlertTriangle } from 'lucide-react';
import { payoutSetupErrorMessage } from '@/lib/payout-setup-errors';

/**
 * Why the last payout-setup attempt failed, kept on the card.
 *
 * A toast alone disappeared after four seconds, which is too short for a sentence that says
 * "add your country of registration in Settings" or "ask your owner". This stays until the
 * next attempt.
 */
export function SetupFailure({ error }: { error: unknown }) {
  if (!error) return null;
  return (
    <div
      role="alert"
      className="flex items-start gap-2 rounded-md border border-status-error/30 bg-status-error/8 px-4 py-3 text-sm text-status-error"
    >
      <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
      <span>{payoutSetupErrorMessage(error)}</span>
    </div>
  );
}
