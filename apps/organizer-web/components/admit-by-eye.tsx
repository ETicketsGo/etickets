'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Eye, Search } from 'lucide-react';
import { api, Badge, Button, Card, Input, errorMessage, useToast } from '@eticketsgo/web-kit';

/**
 * Admitting a customer without scanning anything.
 *
 * ── WHY THIS SCREEN EXISTS ─────────────────────────────────────────────────────────
 * Most Indian cinemas admit visually: somebody reads the ticket, finds the screen and the
 * seat, and waves the customer through. Nothing was recorded when they did — the platform
 * only ever counted scans — so for the venues that make up most of the market, "how full was
 * that show" had no answer, and neither did "who did we let in".
 *
 * ── WHY IT IS A SEARCH AND NOT A SEAT MAP ──────────────────────────────────────────
 * A seat map is the right picture for planning and the wrong one for a doorway: it needs a
 * big screen, two hands and time, and the door has none of those. What the person on the door
 * actually does is read something off the ticket — a seat, a name, a reference — and look for
 * it. So that is the interaction: type what you can see, get a handful back, admit one.
 *
 * ── WHAT THIS IS NOT ───────────────────────────────────────────────────────────────
 * It is not a substitute for scanning where scanning is available. A scan verifies a signed
 * token; this records that a person looked and decided. The server keeps them apart, and so
 * does the wording here — "Admit" rather than "Check in", because the assurance is different
 * and pretending otherwise would put a claim in the record that nobody made.
 */
export function AdmitByEye({ sessionId }: { sessionId: string }) {
  const toast = useToast();
  const qc = useQueryClient();
  const [q, setQ] = useState('');
  const [applied, setApplied] = useState('');

  const roster = useQuery({
    queryKey: ['checkin-roster', sessionId, applied],
    queryFn: () => api.checkins.roster(sessionId, applied || undefined),
    // Nothing to search until a session is chosen; the empty state below says so.
    enabled: Boolean(sessionId),
  });

  const admit = useMutation({
    mutationFn: (ticketId: string) =>
      api.checkins.admitVisually({
        ticketId,
        expectedSessionId: sessionId,
        // Recorded alongside the admission, so a disputed entry can be traced to a door.
        deviceInfo:
          typeof navigator !== 'undefined' ? navigator.userAgent.slice(0, 200) : undefined,
      }),
    onSuccess: async (outcome) => {
      /*
        The server decides, and it can refuse: already admitted, refunded, wrong session, a
        seat another cinema admits. Reporting its message rather than a cheerful default means
        the door hears the actual reason instead of "done" over a refusal.
      */
      const good = outcome.result === 'SUCCESS';
      toast.push(outcome.message, good ? 'success' : 'error');
      await qc.invalidateQueries({ queryKey: ['checkin-roster', sessionId] });
    },
    onError: (e) => toast.push(errorMessage(e), 'error'),
  });

  if (!sessionId) {
    return (
      <Card title="Admit by eye">
        <p className="text-sm text-text-muted">
          Choose a session above to look up tickets without scanning.
        </p>
      </Card>
    );
  }

  const rows = roster.data ?? [];

  return (
    <Card title="Admit by eye">
      <p className="mb-3 text-sm text-text-muted">
        For when you are reading the ticket rather than scanning it. Search by seat, name or booking
        reference. Every admission is recorded as a visual check.
      </p>

      <form
        className="flex items-start gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          setApplied(q.trim());
        }}
      >
        <Input
          aria-label="Search by seat, name or booking reference"
          placeholder="Seat, name or reference"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          className="flex-1"
        />
        <Button type="submit" loading={roster.isFetching}>
          <Search className="h-4 w-4" aria-hidden /> Find
        </Button>
      </form>

      <ul className="mt-3 divide-y divide-border text-sm">
        {rows.length === 0 && !roster.isFetching && (
          <li className="py-3 text-text-muted">
            {applied ? `Nothing matches “${applied}”.` : 'No tickets for this session yet.'}
          </li>
        )}
        {rows.map((r) => {
          const admitted = r.status === 'CHECKED_IN';
          const dead = ['CANCELLED', 'REFUNDED', 'VOID'].includes(r.status);
          return (
            <li key={r.id} className="flex items-center justify-between gap-3 py-2.5">
              <div className="min-w-0">
                <p className="flex items-center gap-2 font-medium text-text-primary">
                  {r.seatLabel ? (
                    <span className="rounded bg-background-subtle px-1.5 py-0.5 tabular-nums">
                      {r.seatLabel}
                    </span>
                  ) : null}
                  <span className="truncate">{r.name ?? '—'}</span>
                </p>
                <p className="truncate text-xs text-text-muted">
                  {r.ticketType}
                  {r.reference && <span className="ml-1.5 font-mono">{r.reference}</span>}
                  {/*
                    A reprint for a customer who arrived without a phone. Opens in a new tab so
                    the door does not lose its place in the roster it is working through.
                  */}
                  {r.bookingId && (
                    <a
                      href={`/organizer/bookings/${r.bookingId}/print`}
                      target="_blank"
                      rel="noreferrer"
                      className="ml-2 underline underline-offset-2 hover:text-text-primary"
                    >
                      Print
                    </a>
                  )}
                </p>
                {/* Said out loud, so the door is not left wondering why Admit refuses. */}
                {r.admittedElsewhereBy && (
                  <p className="text-xs text-status-warning">
                    Admitted by {r.admittedElsewhereBy}, not here.
                  </p>
                )}
              </div>
              {admitted ? (
                <Badge tone="success">Admitted</Badge>
              ) : dead ? (
                <Badge tone="danger">{r.status.toLowerCase()}</Badge>
              ) : (
                <Button
                  size="sm"
                  variant="secondary"
                  loading={admit.isPending && admit.variables === r.id}
                  onClick={() => admit.mutate(r.id)}
                >
                  <Eye className="h-4 w-4" aria-hidden /> Admit
                </Button>
              )}
            </li>
          );
        })}
      </ul>
    </Card>
  );
}
