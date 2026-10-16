'use client';

import { useState } from 'react';
import { Button, Dialog, Textarea } from '@eticketsgo/web-kit';

/**
 * Cancelling a whole event, confirmed: what happens to whom, why (kept with the record), and
 * a deliberate tick, because it refunds everybody and cannot be undone.
 */
export function CancelEventDialog({
  open,
  title,
  bookings,
  busy,
  onClose,
  onConfirm,
}: {
  open: boolean;
  title: string;
  /** Bookings on the event, for the sentence about refunds. */
  bookings: number;
  busy: boolean;
  onClose: () => void;
  onConfirm: (reason: string) => void;
}) {
  const [reason, setReason] = useState('');
  const [sure, setSure] = useState(false);
  const [error, setError] = useState<string | undefined>();

  const confirm = () => {
    if (reason.trim().length < 3) {
      setError('Say why in a few words.');
      return;
    }
    onConfirm(reason.trim());
  };

  return (
    <Dialog
      open={open}
      onClose={() => (busy ? undefined : onClose())}
      title="Cancel this event?"
      footer={
        <>
          <Button variant="outline" onClick={onClose} disabled={busy}>
            Keep the event
          </Button>
          <Button variant="danger" loading={busy} disabled={!sure} onClick={confirm}>
            Cancel event and refund buyers
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <ul className="list-disc space-y-1 pl-5 text-[0.9375rem] text-text-secondary">
          <li>
            Sales of <span className="font-medium text-text-primary">{title}</span> stop now.
          </li>
          <li>
            Every date still to come is cancelled. Dates that already happened stay as they are.
          </li>
          <li>
            {bookings > 0
              ? 'Every paid booking gets a refund request for the full amount. You approve them on Refunds, all at once if you like, and the money goes back the way it was paid.'
              : 'Nobody has booked yet, so there is nothing to refund.'}
          </li>
          <li>
            Every ticket holder is told by email that the show is cancelled and a refund will
            follow.
          </li>
          <li>Cash taken at the counter is not refunded online: give it back at the counter.</li>
        </ul>
        <Textarea
          id="cancel-event-reason"
          label="Why (for your team's records)"
          value={reason}
          rows={3}
          maxLength={500}
          error={error}
          onChange={(e) => {
            setReason(e.target.value);
            setError(undefined);
          }}
        />
        <label className="flex items-start gap-2.5 text-[0.9375rem] text-text-primary">
          <input
            type="checkbox"
            className="mt-1 h-4 w-4 rounded border-border"
            checked={sure}
            onChange={(e) => setSure(e.target.checked)}
          />
          <span>I understand this cannot be undone.</span>
        </label>
      </div>
    </Dialog>
  );
}
