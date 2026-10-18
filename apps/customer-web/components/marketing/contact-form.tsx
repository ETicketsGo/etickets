'use client';

import { useState } from 'react';
import { CheckCircle2 } from 'lucide-react';
import { api, BUSINESS_DETAILS, publishedDetail } from '@eticketsgo/web-kit';
import { MK_FIELD, MK_PANEL, MK_PRIMARY } from './kit';

const TOPICS = ['Sales', 'Support', 'Partnerships', 'Media', 'General enquiry'];

/**
 * The contact form - which now actually delivers.
 *
 * ── WHAT WAS WRONG ─────────────────────────────────────────────────────────────────────
 * This posted nowhere. It opened the visitor's mail client addressed to
 * `hello@eticketsgo.example` - a domain reserved by RFC 2606, so it can never resolve, for
 * anybody, ever - and then showed a panel saying "we'll get back to you soon". Somebody whose
 * card was charged twice would have written to it and waited.
 *
 * ── WHY IT IS A POST NOW ───────────────────────────────────────────────────────────────
 * A real channel was already here and this page never used it: `POST /support` is public,
 * persisted, and shows up in the admin support inbox, which is where an enquiry can actually
 * be read and answered. `CONTACT` is one of its declared kinds. The mailto was a workaround
 * for a missing endpoint that was not missing.
 *
 * The published support address is still shown where we have one, as a second route - but it
 * is read from the single source of business detail, never hardcoded, and never invented.
 */
export function ContactForm() {
  const [topic, setTopic] = useState(TOPICS[0]);
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [message, setMessage] = useState('');
  const [sending, setSending] = useState(false);
  const [sent, setSent] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const inbox = publishedDetail(BUSINESS_DETAILS.supportEmail);

  const emailOk = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
  const valid = name.trim().length > 1 && emailOk && message.trim().length > 4;

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!valid) {
      setError('Please add your name, a valid email, and a short message.');
      return;
    }
    setError(null);
    setSending(true);
    try {
      /*
        The name goes in the message body rather than a field of its own: the endpoint takes
        an email, a subject and a message, and inventing a field here would mean changing a
        contract shared with the organizer console and the admin inbox.
      */
      await api.support.submit({
        kind: 'CONTACT',
        email: email.trim(),
        subject: `[${topic}] Website enquiry`,
        message: `From: ${name.trim()}\n\n${message.trim()}`,
      });
      setSent(true);
    } catch {
      // Say what to do next. An error that only says "something went wrong" wastes the visit.
      setError(
        inbox
          ? `We could not send that. Please try again, or email us at ${inbox}.`
          : 'We could not send that. Please check your connection and try again.',
      );
    } finally {
      setSending(false);
    }
  };

  const field = MK_FIELD;

  if (sent) {
    return (
      <div role="status" className="rounded-brand-card bg-brand-positive-tint p-8 text-center">
        <CheckCircle2 aria-hidden className="mx-auto h-10 w-10 text-brand-positive" />
        <h3 className="mt-4 font-brand-display text-brand-card text-brand-ink">
          Thanks - we have your message
        </h3>
        <p className="mt-2 text-brand-ui text-brand-ink-2">
          It is with our support team and we will reply to{' '}
          <span className="font-medium text-brand-ink">{email.trim()}</span>.
        </p>
      </div>
    );
  }

  return (
    <form onSubmit={submit} className={`space-y-4 p-6 sm:p-8 ${MK_PANEL}`}>
      <div>
        <label
          htmlFor="topic"
          className="mb-1.5 block text-brand-meta font-semibold text-brand-ink"
        >
          Topic
        </label>
        <select
          id="topic"
          value={topic}
          onChange={(e) => setTopic(e.target.value)}
          className={field}
        >
          {TOPICS.map((t) => (
            <option key={t} value={t}>
              {t}
            </option>
          ))}
        </select>
      </div>
      <div className="grid gap-4 sm:grid-cols-2">
        <div>
          <label
            htmlFor="name"
            className="mb-1.5 block text-brand-meta font-semibold text-brand-ink"
          >
            Name
          </label>
          <input
            id="name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            className={field}
            autoComplete="name"
          />
        </div>
        <div>
          <label
            htmlFor="email"
            className="mb-1.5 block text-brand-meta font-semibold text-brand-ink"
          >
            Email
          </label>
          <input
            id="email"
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            className={field}
            autoComplete="email"
          />
        </div>
      </div>
      <div>
        <label
          htmlFor="message"
          className="mb-1.5 block text-brand-meta font-semibold text-brand-ink"
        >
          Message
        </label>
        <textarea
          id="message"
          rows={5}
          value={message}
          onChange={(e) => setMessage(e.target.value)}
          className={`${field} resize-y`}
        />
      </div>
      {error && (
        <p role="alert" className="text-brand-meta font-medium text-brand-critical">
          {error}
        </p>
      )}
      <button type="submit" disabled={sending} className={`${MK_PRIMARY} w-full sm:w-auto`}>
        {sending ? 'Sending...' : 'Send message'}
      </button>
    </form>
  );
}
