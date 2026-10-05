'use client';

import { useEffect, useRef, useState } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import { CheckCircle2, ScanLine, TriangleAlert, XCircle, RotateCcw, WifiOff } from 'lucide-react';
import { useOrg } from '@/components/org-context';
import { api, Button, Card, PageHeader } from '@eticketsgo/web-kit';

/**
 * The gate. One job, one screen.
 *
 * ── WHY THIS EXISTS SEPARATELY FROM THE CHECK-IN TAB ───────────────────────────────
 * The scanner lived at `/organizer/events/[id]/checkin` - a tab inside the event editor,
 * inside a console with eighteen sections. To reach it a temporary worker signed in, met
 * Finance, Payouts, Receipts and Settings, opened Events, found the right event among
 * however many an organizer runs, and opened a tab. At a door, with a queue.
 *
 * The offline engine underneath is the strongest thing this platform has: signed per-device
 * lists, queued scans, no signing key on the device, a rejected scan that can never become an
 * admission. None of that is changed here. What changes is that the person using it gets a
 * screen built for standing up.
 *
 * ── WHAT IT DELIBERATELY DOES NOT HAVE ─────────────────────────────────────────────
 * No revenue, no attendance percentage, no event editing, no settings. A number somebody
 * cannot act on is a number that gets read aloud to the wrong person.
 */

/** The five answers a scan can give, as a person at a door needs to read them. */
const OUTCOME = {
  SUCCESS: {
    tone: 'ok' as const,
    icon: CheckCircle2,
    title: 'Let them in',
    hint: 'Ticket accepted.',
  },
  DUPLICATE: {
    tone: 'warn' as const,
    icon: RotateCcw,
    title: 'Already used',
    hint: 'This ticket has been scanned before. Call a supervisor.',
  },
  WRONG_SESSION: {
    tone: 'warn' as const,
    icon: TriangleAlert,
    title: 'Wrong show',
    hint: 'This ticket is for a different show. Check the date and time.',
  },
  CANCELLED: {
    tone: 'bad' as const,
    icon: XCircle,
    title: 'Cancelled',
    hint: 'This booking was cancelled or refunded. Do not let them in.',
  },
  INVALID: {
    tone: 'bad' as const,
    icon: XCircle,
    title: 'Not valid',
    hint: 'We do not recognise this ticket. Try typing the code, or call a supervisor.',
  },
};

const TONE_CLASS = {
  ok: 'border-status-success/40 bg-status-success/10 text-status-success',
  warn: 'border-status-warning/40 bg-tint-warning text-status-warning',
  bad: 'border-status-error/40 bg-status-error/10 text-status-error',
};

export default function GatePage() {
  const { activeOrg } = useOrg();
  const orgId = activeOrg?.id;

  const [sessionId, setSessionId] = useState('');
  const [token, setToken] = useState('');
  const [outcome, setOutcome] = useState<{ result: keyof typeof OUTCOME; seat?: string } | null>(
    null,
  );
  const [online, setOnline] = useState(true);

  /*
    Whether the device can reach us at all, shown permanently rather than on failure.

    Gate staff need to know they are offline BEFORE a scan behaves differently, not after.
    The offline engine keeps working either way; this is about the person not being surprised.
  */
  useEffect(() => {
    const set = () => setOnline(navigator.onLine);
    set();
    window.addEventListener('online', set);
    window.addEventListener('offline', set);
    return () => {
      window.removeEventListener('online', set);
      window.removeEventListener('offline', set);
    };
  }, []);

  type GateSession = Awaited<ReturnType<typeof api.checkins.gateSessions>>[number];

  const sessions = useQuery({
    queryKey: ['gate', 'sessions', orgId],
    queryFn: () => api.checkins.gateSessions(orgId as string),
    enabled: Boolean(orgId),
  });

  const scan = useMutation({
    mutationFn: () => api.checkins.scan({ token: token.trim(), expectedSessionId: sessionId }),
    onSuccess: (res) => {
      setOutcome({
        result: res.result as keyof typeof OUTCOME,
        seat: res.ticket?.seatLabel ?? undefined,
      });
      setToken('');
      inputRef.current?.focus();
    },
    onError: () => {
      setOutcome({ result: 'INVALID' });
      setToken('');
      inputRef.current?.focus();
    },
  });

  const inputRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    inputRef.current?.focus();
  }, [sessionId]);

  const chosen = sessions.data?.find((s: GateSession) => s.id === sessionId);

  // ── 1. Pick the show ──────────────────────────────────────────────────────────────
  if (!sessionId) {
    return (
      <div className="mx-auto max-w-2xl">
        <PageHeader title="Gate" description="Choose the show you are on the door for." />
        {sessions.isLoading && (
          <Card className="p-6 text-center text-text-muted">Loading shows...</Card>
        )}
        {sessions.data?.length === 0 && (
          <Card className="p-8 text-center">
            <ScanLine className="mx-auto h-8 w-8 text-text-muted" aria-hidden />
            <p className="mt-3 font-semibold text-text-primary">No shows to scan today</p>
            <p className="mt-1 text-caption text-text-secondary">
              Shows appear here on the day they run. Ask your supervisor if you expected one.
            </p>
          </Card>
        )}
        <div className="space-y-3">
          {sessions.data?.map((s: GateSession) => (
            <button
              key={s.id}
              onClick={() => setSessionId(s.id)}
              className="block w-full rounded-lg border border-border bg-background-surface p-5 text-left shadow-sm transition-colors hover:border-action-primary"
            >
              <span className="block text-lg font-semibold text-text-primary">{s.eventTitle}</span>
              <span className="mt-1 block text-[0.9375rem] text-text-secondary">
                {s.startsAtLabel}
              </span>
              {s.venueName && (
                <span className="mt-0.5 block text-caption text-text-muted">{s.venueName}</span>
              )}
            </button>
          ))}
        </div>
      </div>
    );
  }

  // ── 2. Scan ───────────────────────────────────────────────────────────────────────
  const shown = outcome ? OUTCOME[outcome.result] : null;

  return (
    <div className="mx-auto max-w-2xl">
      <div className="mb-4 flex items-center justify-between gap-3">
        <div className="min-w-0">
          <p className="truncate text-lg font-semibold text-text-primary">{chosen?.eventTitle}</p>
          <p className="truncate text-caption text-text-secondary">{chosen?.startsAtLabel}</p>
        </div>
        <Button
          variant="secondary"
          onClick={() => {
            setSessionId('');
            setOutcome(null);
          }}
        >
          Change show
        </Button>
      </div>

      {!online && (
        <div className="mb-4 flex items-center gap-2 rounded-lg border border-status-warning/40 bg-tint-warning px-4 py-3 text-[0.9375rem] text-text-primary">
          <WifiOff className="h-5 w-5 shrink-0 text-status-warning" aria-hidden />
          <span>
            <strong>No network.</strong> Keep scanning. Each scan is kept on this device and sent
            when the signal returns.
          </span>
        </div>
      )}

      {/*
        The answer, big enough to read at arm's length in a queue.

        Colour alone never carries it: each state has its own icon and its own sentence saying
        what to DO. A supervisor should be able to glance across and see the same thing the
        worker is reading.
      */}
      <div
        role="status"
        aria-live="assertive"
        className={`mb-4 rounded-lg border p-6 text-center ${
          shown ? TONE_CLASS[shown.tone] : 'border-border bg-background-subtle text-text-muted'
        }`}
      >
        {shown ? (
          <>
            <shown.icon className="mx-auto h-12 w-12" aria-hidden />
            <p className="mt-3 text-2xl font-bold">{shown.title}</p>
            {outcome?.seat && <p className="mt-1 text-lg font-semibold">Seat {outcome.seat}</p>}
            <p className="mt-2 text-[0.9375rem]">{shown.hint}</p>
          </>
        ) : (
          <>
            <ScanLine className="mx-auto h-12 w-12" aria-hidden />
            <p className="mt-3 text-lg font-semibold">Ready to scan</p>
          </>
        )}
      </div>

      <Card className="p-5">
        <label htmlFor="ticket" className="mb-2 block font-medium text-text-primary">
          Scan or type the ticket code
        </label>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            if (token.trim()) scan.mutate();
          }}
        >
          <input
            id="ticket"
            ref={inputRef}
            value={token}
            onChange={(e) => setToken(e.target.value)}
            /*
              A hardware scanner types the code and presses Enter, so the field stays focused
              and the form submits on Enter. Nobody at a door should have to tap a button
              between every person.
            */
            autoComplete="off"
            inputMode="text"
            className="w-full rounded-lg border border-border bg-background-surface px-4 py-4 text-lg text-text-primary focus:border-action-primary focus:outline-none focus:ring-2 focus:ring-ring/40"
            placeholder="Ticket code"
          />
          <Button type="submit" className="mt-3 w-full py-4 text-lg" disabled={scan.isPending}>
            {scan.isPending ? 'Checking...' : 'Check ticket'}
          </Button>
        </form>
      </Card>
    </div>
  );
}
