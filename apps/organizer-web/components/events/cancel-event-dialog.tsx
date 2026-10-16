'use client';

import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { api, Button, Dialog, Skeleton, Textarea } from '@eticketsgo/web-kit';
import { previewLines } from '@/lib/cancel-impact';

/**
 * Cancelling a whole event, confirmed: what happens to whom, in counts and totals read from the
 * server before anything is done, why (kept with the record), and a deliberate tick, because it
 * refunds everybody and cannot be undone.
 */
export function CancelEventDialog({
  open,
  eventId,
  title,
  busy,
  onClose,
  onConfirm,
}: {
  open: boolean;
  eventId: string;
  title: string;
  busy: boolean;
  onClose: () => void;
  onConfirm: (reason: string) => void;
}) {
  const [reason, setReason] = useState('');
  const [sure, setSure] = useState(false);
  const [error, setError] = useState<string | undefined>();
  /*
    The impact, asked fresh each time the dialog opens: a counter sale a minute ago changes the
    cash to give back, and a stale figure here is the one the organizer takes out of the till.
  */
  const preview = useQuery({
    queryKey: ['event-cancel-preview', eventId],
    queryFn: () => api.events.cancelPreview(eventId),
    enabled: open,
    staleTime: 0,
    gcTime: 0,
  });

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
          {preview.isLoading ? (
            <li className="list-none">
              <Skeleton className="h-16 w-full" />
            </li>
          ) : preview.data ? (
            previewLines(preview.data).map((line) => <li key={line}>{line}</li>)
          ) : (
            <li>
              We could not work out the refunds and cash just now. Every paid online booking still
              gets a refund request, and cash bookings are cancelled for you to pay back at the
              counter.
            </li>
          )}
          <li>Every ticket holder is told by email that the show is cancelled.</li>
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
