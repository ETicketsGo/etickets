'use client';

import { useState } from 'react';
import { api, Button, Card, Textarea, errorMessage } from '@eticketsgo/web-kit';
import { supportContactHref } from '../lib/suspension';

/**
 * What a member of a SUSPENDED organization sees instead of the organizer console.
 *
 * Owner decision (2026-10-26): no console functionality by any route, only a way to support
 * and a way out. So this screen has no navigation, no organization data and no actions except:
 *   - ask support (an appeal), sent through the same support endpoint the console's help page
 *     uses, filed under the organization so support can find it;
 *   - the storefront's contact page, for anybody who prefers it;
 *   - sign out.
 * The API is what keeps the data closed (every organizer route answers 403
 * ORGANIZATION_SUSPENDED); this screen only says so plainly.
 *
 * Signing out of the console does not take anything else away: the same account still buys
 * tickets on the storefront.
 */
export function SuspendedOrganizationScreen({
  organizations,
  storefront,
  onSignOut,
}: {
  organizations: { id: string; name: string }[];
  storefront: string | null;
  onSignOut: () => void;
}) {
  const names = organizations.map((o) => o.name);
  const subject = organizations[0];
  const [message, setMessage] = useState('');
  const [sending, setSending] = useState(false);
  const [sent, setSent] = useState(false);
  const [error, setError] = useState('');
  const contact = supportContactHref(storefront);

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
        subject: `Suspended organization - ${subject?.name ?? 'organizer'}`.slice(0, 160),
        message: message.trim(),
        metadata: {
          source: 'organizer-suspended',
          organizationId: subject?.id,
          organizationName: subject?.name,
        },
      });
      setSent(true);
      setMessage('');
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setSending(false);
    }
  };

  return (
    <main
      className="grid min-h-screen place-items-center bg-background-canvas p-4"
      data-testid="organization-suspended"
    >
      <Card className="w-full max-w-lg">
        <h1 className="text-title font-semibold text-text-primary">
          This organization is suspended
        </h1>
        <p className="mt-2 text-[0.9375rem] text-text-secondary">
          {names.length === 1 ? (
            <>
              ETicketsGo has suspended <strong>{names[0]}</strong>.
            </>
          ) : (
            <>ETicketsGo has suspended these organizations: {names.join(', ')}.</>
          )}{' '}
          While it is suspended, its organizer console is closed and its events are not on sale.
          Your account still works for buying tickets.
        </p>
        <p className="mt-2 text-[0.9375rem] text-text-secondary">
          To find out why, or to ask us to look again, send a message to ETicketsGo support. We
          reply to the email address on your account.
        </p>

        {sent ? (
          <p
            role="status"
            className="mt-4 rounded-md border border-status-success/30 bg-status-success/10 px-3 py-2 text-[0.9375rem] text-text-primary"
          >
            We have your message. Our support team will reply by email.
          </p>
        ) : (
          <form
            className="mt-4 space-y-3"
            onSubmit={(e) => {
              e.preventDefault();
              void send();
            }}
          >
            <Textarea
              id="suspension-message"
              label="Your message to support"
              rows={4}
              maxLength={4000}
              value={message}
              onChange={(e) => setMessage(e.target.value)}
              error={error || undefined}
            />
            <Button type="submit" loading={sending} disabled={sending}>
              Send to support
            </Button>
          </form>
        )}

        <div className="mt-5 flex flex-col gap-3 border-t border-border pt-4 sm:flex-row sm:items-center sm:justify-between">
          {contact ? (
            <a
              href={contact}
              data-testid="suspension-contact"
              className="text-[0.9375rem] font-semibold text-text-primary underline underline-offset-4"
            >
              Contact ETicketsGo support
            </a>
          ) : (
            <span />
          )}
          <Button variant="secondary" onClick={onSignOut} data-testid="suspension-sign-out">
            Sign out
          </Button>
        </div>
      </Card>
    </main>
  );
}
