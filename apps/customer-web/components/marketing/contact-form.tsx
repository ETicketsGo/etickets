'use client';

import { useState } from 'react';
import { CheckCircle2 } from 'lucide-react';

const TOPICS = ['Sales', 'Support', 'Partnerships', 'Media', 'General enquiry'];

/** A functional, client-side contact form. With no contact API in the demo it validates
 *  input and confirms locally (and offers a mailto fallback); wire to an endpoint later. */
export function ContactForm() {
  const [topic, setTopic] = useState(TOPICS[0]);
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [message, setMessage] = useState('');
  const [sent, setSent] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const emailOk = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
  const valid = name.trim().length > 1 && emailOk && message.trim().length > 4;

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!valid) {
      setError('Please add your name, a valid email, and a short message.');
      return;
    }
    setError(null);
    // Fallback delivery in the demo (no contact API yet): open the user's mail client.
    const body = encodeURIComponent(`Topic: ${topic}\nFrom: ${name} <${email}>\n\n${message}`);
    window.location.href = `mailto:hello@eticketsgo.example?subject=${encodeURIComponent(
      `[${topic}] Website enquiry`,
    )}&body=${body}`;
    setSent(true);
  };

  const field =
    'w-full rounded-xl border border-border bg-background-surface px-3.5 py-2.5 text-[0.9375rem] text-text-primary shadow-xs transition-colors placeholder:text-text-muted focus:border-action-primary focus:outline-none focus:ring-2 focus:ring-ring/40';

  if (sent) {
    return (
      <div className="rounded-2xl border border-status-success/30 bg-status-success/5 p-8 text-center">
        <CheckCircle2 className="mx-auto h-10 w-10 text-status-success" />
        <h3 className="mt-4 text-lg font-semibold text-text-primary">
          Thanks — your message is ready to send
        </h3>
        <p className="mt-2 text-[0.9375rem] text-text-secondary">
          We opened your email client to deliver it. If nothing happened, email us at the address
          listed — we&rsquo;ll get back to you soon.
        </p>
      </div>
    );
  }

  return (
    <form
      onSubmit={submit}
      className="space-y-4 rounded-2xl border border-border bg-background-surface p-6 shadow-sm sm:p-8"
    >
      <div>
        <label
          htmlFor="topic"
          className="mb-1.5 block text-caption font-medium text-text-secondary"
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
            className="mb-1.5 block text-caption font-medium text-text-secondary"
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
            className="mb-1.5 block text-caption font-medium text-text-secondary"
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
          className="mb-1.5 block text-caption font-medium text-text-secondary"
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
        <p role="alert" className="text-caption text-status-error">
          {error}
        </p>
      )}
      <button
        type="submit"
        className="inline-flex w-full items-center justify-center rounded-xl bg-action-primary px-5 py-3 text-[0.9375rem] font-semibold text-action-primary-foreground shadow-sm transition-all hover:bg-action-primary-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/60 focus-visible:ring-offset-2 focus-visible:ring-offset-background-canvas sm:w-auto"
      >
        Send message
      </button>
    </form>
  );
}
