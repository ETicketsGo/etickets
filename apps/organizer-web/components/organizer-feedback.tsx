'use client';

import { useState } from 'react';
import { MessageSquareHeart } from 'lucide-react';
import {
  api,
  ApiRequestError,
  Button,
  Card,
  Dialog,
  RatingStars,
  Textarea,
  useToast,
} from '@eticketsgo/web-kit';

/**
 * Organizer satisfaction survey + "Send feedback" action for the Help page.
 * Submits an ORGANIZER_CSAT with a required rating and an optional message via
 * the shared support endpoint (the API attaches the signed-in organizer).
 */
export function OrganizerFeedback() {
  const toast = useToast();
  const [open, setOpen] = useState(false);
  const [rating, setRating] = useState(0);
  const [message, setMessage] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');

  const close = () => {
    setOpen(false);
    setRating(0);
    setMessage('');
    setError('');
  };

  const submit = async () => {
    if (rating < 1) {
      setError('Please choose a rating from 1 to 5.');
      return;
    }
    setSubmitting(true);
    setError('');
    try {
      await api.support.submit({
        kind: 'ORGANIZER_CSAT',
        rating,
        message: message.trim() || 'No additional comments.',
      });
      toast.push('Thanks for your feedback!', 'success');
      close();
    } catch (err) {
      const msg =
        err instanceof ApiRequestError || err instanceof Error
          ? err.message
          : 'Something went wrong.';
      setError(msg);
      toast.push(msg, 'error');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Card>
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="flex items-start gap-3">
          <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-action-primary/10 text-action-primary">
            <MessageSquareHeart className="h-5 w-5" />
          </span>
          <div>
            <p className="font-semibold text-text-primary">How is ETicketsGo working for you?</p>
            <p className="mt-1 text-[0.9375rem] text-text-muted">
              Share a quick rating and any thoughts — it helps us improve the organizer experience.
            </p>
          </div>
        </div>
        <Button variant="outline" onClick={() => setOpen(true)}>
          Send feedback
        </Button>
      </div>

      <Dialog
        open={open}
        onClose={close}
        title="Organizer satisfaction survey"
        footer={
          <>
            <Button variant="ghost" onClick={close} disabled={submitting}>
              Cancel
            </Button>
            <Button onClick={submit} loading={submitting} disabled={submitting}>
              Submit feedback
            </Button>
          </>
        }
      >
        <div className="space-y-4">
          <div>
            <p className="mb-1.5 text-[0.8125rem] font-medium text-text-secondary">
              Overall, how satisfied are you?
            </p>
            <RatingStars value={rating} onChange={setRating} size="lg" label="Your rating" />
          </div>
          <Textarea
            id="org-feedback-message"
            label="Comments (optional)"
            value={message}
            onChange={(e) => setMessage(e.target.value)}
            placeholder="What's going well? What could be better?"
            rows={4}
            error={error}
            maxLength={4000}
          />
        </div>
      </Dialog>
    </Card>
  );
}
