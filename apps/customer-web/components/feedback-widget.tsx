'use client';

import { useState } from 'react';
import { MessageSquarePlus } from 'lucide-react';
import { api, ApiRequestError } from '@/lib/api';
import { Button, Dialog, Textarea, RatingStars, useToast } from '@/components/ui';

/**
 * Unobtrusive floating "Feedback" button mounted app-wide. Opens a dialog for a
 * quick message plus an optional star rating. When a rating is given the
 * submission is a CSAT; otherwise it is GENERAL feedback. Dismissible via the
 * close button, Escape, or backdrop click (Dialog handles focus trapping).
 */
export function FeedbackWidget() {
  const toast = useToast();
  const [open, setOpen] = useState(false);
  const [message, setMessage] = useState('');
  const [rating, setRating] = useState(0);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');

  const reset = () => {
    setMessage('');
    setRating(0);
    setError('');
  };

  const close = () => {
    setOpen(false);
    reset();
  };

  const submit = async () => {
    if (!message.trim()) {
      setError('Please enter a short message.');
      return;
    }
    setSubmitting(true);
    setError('');
    try {
      await api.submitFeedback({
        kind: rating > 0 ? 'CSAT' : 'GENERAL',
        message,
        ...(rating > 0 ? { rating } : {}),
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
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        aria-label="Send feedback"
        className="fixed bottom-5 left-5 z-40 flex items-center gap-2 rounded-full border border-border bg-background-elevated px-4 py-2.5 text-[0.9375rem] font-medium text-text-secondary shadow-lg transition-all duration-200 ease-premium hover:-translate-y-0.5 hover:text-text-primary hover:shadow-xl focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:ring-offset-2 focus-visible:ring-offset-background-canvas"
      >
        <MessageSquarePlus className="h-4 w-4" aria-hidden />
        <span className="hidden sm:inline">Feedback</span>
      </button>

      <Dialog
        open={open}
        onClose={close}
        title="Share your feedback"
        footer={
          <>
            <Button variant="ghost" onClick={close} disabled={submitting}>
              Cancel
            </Button>
            <Button onClick={submit} loading={submitting} disabled={submitting}>
              Send feedback
            </Button>
          </>
        }
      >
        <div className="space-y-4">
          <div>
            <p className="mb-1.5 text-[0.8125rem] font-medium text-text-secondary">
              Rate your experience (optional)
            </p>
            <RatingStars value={rating} onChange={setRating} size="lg" label="Your rating" />
          </div>
          <Textarea
            id="widget-message"
            label="What's on your mind?"
            value={message}
            onChange={(e) => setMessage(e.target.value)}
            placeholder="Tell us what's working or what could be better…"
            rows={4}
            error={error}
            maxLength={4000}
          />
        </div>
      </Dialog>
    </>
  );
}
