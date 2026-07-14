'use client';

import { useEffect, useState, type FormEvent } from 'react';
import { useAuthUser } from '@eticketsgo/web-kit';
import { api, ApiRequestError, type FeedbackSubmission } from '@/lib/api';
import { Button, Input, Textarea, RatingStars, useToast } from '@/components/ui';

type Kind = FeedbackSubmission['kind'];

/**
 * Shared submission form for the Help center flows. `kind` selects the payload
 * (CONTACT / BUG / FEATURE / CSAT); BUG auto-captures the page URL + user agent
 * in metadata; CSAT shows a required star rating. Anonymous senders provide an
 * email; signed-in senders have it prefilled and the API attaches their account.
 */
export function FeedbackForm({
  kind,
  showSubject = false,
  showRating = false,
  submitLabel = 'Send',
  successMessage = 'Thanks — your message has been sent.',
  messageLabel = 'Message',
  messagePlaceholder,
}: {
  kind: Kind;
  showSubject?: boolean;
  showRating?: boolean;
  submitLabel?: string;
  successMessage?: string;
  messageLabel?: string;
  messagePlaceholder?: string;
}) {
  const toast = useToast();
  const { user } = useAuthUser();
  const [email, setEmail] = useState('');
  const [subject, setSubject] = useState('');
  const [message, setMessage] = useState('');
  const [rating, setRating] = useState(0);
  const [submitting, setSubmitting] = useState(false);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [done, setDone] = useState(false);

  useEffect(() => {
    if (user?.email) setEmail(user.email);
  }, [user?.email]);

  const onSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setErrors({});
    if (showRating && rating < 1) {
      setErrors({ rating: 'Please choose a rating.' });
      return;
    }
    setSubmitting(true);
    try {
      const metadata =
        kind === 'BUG' && typeof window !== 'undefined'
          ? { url: window.location.href, userAgent: navigator.userAgent }
          : undefined;
      await api.submitFeedback({
        kind,
        message,
        ...(email ? { email } : {}),
        ...(showSubject && subject ? { subject } : {}),
        ...(showRating ? { rating } : {}),
        ...(metadata ? { metadata } : {}),
      });
      setDone(true);
      setMessage('');
      setSubject('');
      setRating(0);
      toast.push(successMessage, 'success');
    } catch (err) {
      if (err instanceof ApiRequestError && err.details?.fields) {
        const fields = err.details.fields as Record<string, string[]>;
        setErrors(Object.fromEntries(Object.entries(fields).map(([k, v]) => [k, v[0]])));
      }
      toast.push(err instanceof Error ? err.message : 'Something went wrong.', 'error');
    } finally {
      setSubmitting(false);
    }
  };

  if (done) {
    return (
      <div
        role="status"
        className="rounded-lg border border-status-success/30 bg-status-success/5 p-6 text-center"
      >
        <p className="font-semibold text-status-success">{successMessage}</p>
        <p className="mt-1 text-[0.9375rem] text-text-muted">
          We appreciate you taking the time to reach out.
        </p>
        <Button variant="outline" className="mt-4" onClick={() => setDone(false)}>
          Send another
        </Button>
      </div>
    );
  }

  return (
    <form onSubmit={onSubmit} className="space-y-4" noValidate>
      {showRating && (
        <div>
          <p className="mb-1.5 text-[0.8125rem] font-medium text-text-secondary">
            How satisfied are you?
          </p>
          <RatingStars value={rating} onChange={setRating} size="lg" label="Your rating" />
          {errors.rating && (
            <p role="alert" className="mt-1.5 text-caption text-status-error">
              {errors.rating}
            </p>
          )}
        </div>
      )}
      <Input
        id="fb-email"
        type="email"
        label={user ? 'Reply-to email' : 'Your email'}
        value={email}
        onChange={(e) => setEmail(e.target.value)}
        placeholder="you@example.com"
        error={errors.email}
        required={kind === 'CONTACT' && !user}
        autoComplete="email"
      />
      {showSubject && (
        <Input
          id="fb-subject"
          label="Subject"
          value={subject}
          onChange={(e) => setSubject(e.target.value)}
          placeholder="How can we help?"
          error={errors.subject}
          maxLength={160}
        />
      )}
      <Textarea
        id="fb-message"
        label={messageLabel}
        value={message}
        onChange={(e) => setMessage(e.target.value)}
        placeholder={messagePlaceholder}
        error={errors.message}
        rows={5}
        required
        maxLength={4000}
      />
      <Button type="submit" loading={submitting} disabled={submitting}>
        {submitLabel}
      </Button>
    </form>
  );
}
