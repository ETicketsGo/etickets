'use client';

import { useState } from 'react';
import { MessageSquarePlus } from 'lucide-react';
import { api, ApiRequestError } from '@/lib/api';
import { Button, Dialog, Textarea, RatingStars, useToast } from '@/components/ui';

/**
 * "Send feedback": a quiet button that opens a dialog for a short message and an optional star
 * rating. With a rating the submission is a CSAT; otherwise it is GENERAL feedback.
 *
 * ── WHY IT IS NOT FLOATING ANY MORE ────────────────────────────────────────────────
 * It was a pill pinned to a corner of every page, and a floating button always covers
 * something: on a phone it sat behind the navigation bar, then over a card's badge, then over a
 * PRICE ("From Rs 49_"); on a desktop it sat over the first card of every list and over
 * Review & pay (EXPERIENCE-AUDIT.md, C5). It is a utility, so it lives where utilities live: in
 * the footer, on every page, covering nothing.
 */
export function FeedbackButton({ label, className = '' }: { label: string; className?: string }) {
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
      <button type="button" onClick={() => setOpen(true)} className={className}>
        <MessageSquarePlus className="h-4 w-4" aria-hidden />
        {label}
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
            placeholder="Tell us what's working or what could be better..."
            rows={4}
            error={error}
            maxLength={4000}
          />
        </div>
      </Dialog>
    </>
  );
}
