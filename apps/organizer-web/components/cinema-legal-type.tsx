'use client';

import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { CheckCircle2 } from 'lucide-react';
import { api, Button, Dialog, Textarea, errorMessage } from '@eticketsgo/web-kit';
import { useOrg } from '@/components/org-context';
import { legalTypeText } from './cinema-legal-type-words';

/**
 * The cinema's legal type, read-only, with a way to ask ETicketsGo to change it.
 *
 * ── WHY THE ORGANIZER CANNOT EDIT IT ───────────────────────────────────────────────
 * Local body, format and cooling pick the row of a state rate order the cinema is priced
 * under: the most a ticket may cost. An organizer choosing them would be choosing their own
 * price limit, so the API refuses them from an organizer and the platform team sets them (from
 * the admin console, with a reason on the record).
 *
 * What the organizer CAN do is see what is on record and say when it is wrong. The request goes
 * through the same support endpoint as Help & support, naming the cinema, so it lands in the
 * admin support inbox with everything needed to act on it.
 */
export function CinemaLegalType({
  cinemaId,
  value,
  needed,
}: {
  cinemaId: string;
  value: {
    localBodyType: string | null;
    cinemaFormat: string | null;
    climateType: string | null;
  };
  /** True where the state's price order depends on it, so a gap is a problem worth saying. */
  needed: boolean;
}) {
  const [asking, setAsking] = useState(false);
  const [sent, setSent] = useState(false);
  const text = legalTypeText(value);

  return (
    <div>
      <dt className="text-caption uppercase tracking-wide text-text-muted">Legal type</dt>
      <dd className="text-text-primary">
        {text ?? 'Not on record'}
        <span className="block text-caption text-text-muted">
          {needed && !text
            ? 'Needed here: the state sets prices by it. Only ETicketsGo can set it.'
            : 'Local body, format and cooling. It decides the highest price allowed, so only ETicketsGo can set it.'}
        </span>
        {sent ? (
          <span
            role="status"
            className="mt-2 flex items-start gap-1.5 text-caption text-status-success"
          >
            <CheckCircle2 className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden />
            Request sent. ETicketsGo will reply by email.
          </span>
        ) : (
          <Button size="sm" variant="secondary" className="mt-2" onClick={() => setAsking(true)}>
            Ask ETicketsGo to change this
          </Button>
        )}
      </dd>
      <AskDialog
        open={asking}
        cinemaId={cinemaId}
        current={text ?? 'nothing yet'}
        onClose={() => setAsking(false)}
        onSent={() => {
          setAsking(false);
          setSent(true);
        }}
      />
    </div>
  );
}

function AskDialog({
  open,
  cinemaId,
  current,
  onClose,
  onSent,
}: {
  open: boolean;
  cinemaId: string;
  current: string;
  onClose: () => void;
  onSent: () => void;
}) {
  const { activeOrg } = useOrg();
  // The cinema's name for the request's subject. Same key as the cinema page, so it is cached.
  const cinema = useQuery({
    queryKey: ['cinema', cinemaId],
    queryFn: () => api.cinemas.get(cinemaId),
  });
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const [sending, setSending] = useState(false);
  const name = cinema.data?.name ?? 'this cinema';

  const send = async () => {
    if (message.trim().length < 5) {
      setError('Say what it should be, so we can check it.');
      return;
    }
    setSending(true);
    setError('');
    try {
      await api.support.submit({
        kind: 'CONTACT',
        subject: `Change cinema legal type - ${name}`.slice(0, 160),
        message: `Cinema: ${name}\nOn record now: ${current}\n\n${message.trim()}`,
        metadata: {
          source: 'cinema-legal-type',
          cinemaId,
          organizationId: activeOrg.id,
          organizationName: activeOrg.name,
          // Where the platform team sets it, so the request carries its own way to act.
          adminPath: `/admin/cinema-pricing/legal-types?cinema=${cinemaId}`,
        },
      });
      setMessage('');
      onSent();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setSending(false);
    }
  };

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="Ask ETicketsGo to change the legal type"
      description={`On record for ${name}: ${current}.`}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={() => void send()} loading={sending}>
            Send request
          </Button>
        </>
      }
    >
      <Textarea
        id="legal-type-request"
        label="What should it be, and why?"
        hint="For example: Municipal corporation, single screen, air-conditioned. Our licence says so. We reply to the email you sign in with."
        rows={4}
        value={message}
        error={error || undefined}
        onChange={(e) => setMessage(e.target.value)}
      />
    </Dialog>
  );
}
