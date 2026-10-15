'use client';

import { useState } from 'react';
import { CheckCircle2, LifeBuoy } from 'lucide-react';
import { api, Button, Card, Select, Textarea, errorMessage, useToast } from '@eticketsgo/web-kit';
import { useOrg } from '@/components/org-context';

/** What the message is about, in the organizer's words. Becomes the subject the inbox shows. */
const TOPICS = [
  'Getting approved',
  'Payouts and bank account',
  'An event or its tickets',
  'Refunds',
  'Check-in at the door',
  'My team or my account',
  'Something else',
];

/**
 * Ask ETicketsGo support a question, from inside the console.
 *
 * ── WHY THIS EXISTS ────────────────────────────────────────────────────────────────
 * Help & support told organizers "use Send feedback below - it reaches us". Send feedback is a
 * satisfaction survey: it would not send without a 1-5 star rating, and an organizer whose
 * payout had not arrived was being asked how satisfied they were. Nothing an organizer could
 * write reached the admin support inbox as a question.
 *
 * This sends a CONTACT message through the same support endpoint the storefront's contact form
 * uses. The reply goes to the signed-in account's email (the API attaches it), and the message
 * names this organization so the admin inbox files it under them - the API checks the sender is
 * an active member before it believes that.
 */
export function OrganizerSupportForm() {
  const { activeOrg } = useOrg();
  const toast = useToast();
  const [topic, setTopic] = useState(TOPICS[0]);
  const [message, setMessage] = useState('');
  const [sending, setSending] = useState(false);
  const [sent, setSent] = useState(false);
  const [error, setError] = useState('');

  const send = async () => {
    if (message.trim().length < 5) {
      setError('Tell us a little more so we can help.');
      return;
    }
    setSending(true);
    setError('');
    try {
      await api.support.submit({
        kind: 'CONTACT',
        subject: `${topic} - ${activeOrg.name}`.slice(0, 160),
        message: message.trim(),
        metadata: {
          source: 'organizer-help',
          organizationId: activeOrg.id,
          organizationName: activeOrg.name,
          url: typeof window !== 'undefined' ? window.location.href : undefined,
        },
      });
      setSent(true);
      setMessage('');
      toast.push('Message sent to ETicketsGo support.', 'success');
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setSending(false);
    }
  };

  return (
    <Card>
      <div className="flex items-start gap-3">
        <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-tint-primary text-action-primary">
          <LifeBuoy className="h-5 w-5" aria-hidden />
        </span>
        <div className="min-w-0 flex-1">
          <h2 className="font-semibold text-text-primary">Contact support</h2>
          <p className="mt-1 text-[0.9375rem] text-text-muted">
            Ask us anything about {activeOrg.name}. We reply to the email address you sign in with.
          </p>
          {sent ? (
            <div
              role="status"
              className="mt-4 flex items-start gap-2 rounded-md border border-status-success/30 bg-status-success/10 px-3 py-2 text-[0.9375rem] text-text-primary"
            >
              <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-status-success" aria-hidden />
              <span>
                We have your message. Our support team will reply by email.{' '}
                <button
                  type="button"
                  className="font-semibold underline underline-offset-4"
                  onClick={() => setSent(false)}
                >
                  Send another
                </button>
              </span>
            </div>
          ) : (
            <form
              className="mt-4 max-w-xl space-y-4"
              onSubmit={(e) => {
                e.preventDefault();
                void send();
              }}
            >
              <Select
                id="support-topic"
                label="What is it about?"
                value={topic}
                onChange={(e) => setTopic(e.target.value)}
              >
                {TOPICS.map((t) => (
                  <option key={t} value={t}>
                    {t}
                  </option>
                ))}
              </Select>
              <Textarea
                id="support-message"
                label="Your message"
                rows={5}
                maxLength={4000}
                value={message}
                onChange={(e) => setMessage(e.target.value)}
                placeholder="What happened, and what do you need from us?"
                error={error || undefined}
              />
              <Button type="submit" loading={sending} disabled={sending}>
                Send message
              </Button>
            </form>
          )}
        </div>
      </div>
    </Card>
  );
}
