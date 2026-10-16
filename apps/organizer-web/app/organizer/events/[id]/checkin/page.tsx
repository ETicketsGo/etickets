'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { AdmitByEye } from '@/components/admit-by-eye';
import { useParams } from 'next/navigation';
import { useEffect, useRef, useState } from 'react';
import { CheckCircle2, WifiOff } from 'lucide-react';
import {
  api,
  Button,
  Card,
  Textarea,
  Select,
  Badge,
  Input,
  StatusBadge,
  ErrorState,
  useToast,
  useOnline,
  errorMessage,
  type CheckInOutcome,
  type BadgeTone,
  recordedAt,
} from '@eticketsgo/web-kit';
import { OfflineCheckin } from '@/components/offline-checkin';
import { timeAtVenue } from '@/components/events/event-list-model';
import { looksLikeTicketNumber } from '@/lib/ticket-number';

interface DetectedBarcode {
  rawValue: string;
}
interface BarcodeDetectorLike {
  detect(source: CanvasImageSource): Promise<DetectedBarcode[]>;
}
declare global {
  interface Window {
    BarcodeDetector?: new (opts?: { formats: string[] }) => BarcodeDetectorLike;
  }
}

const RESULT_TONE: Record<CheckInOutcome['result'], BadgeTone> = {
  SUCCESS: 'success',
  DUPLICATE: 'warning',
  INVALID: 'error',
  CANCELLED: 'error',
  WRONG_SESSION: 'warning',
};

export default function CheckinTab() {
  const { id } = useParams<{ id: string }>();
  const toast = useToast();
  const qc = useQueryClient();
  const online = useOnline();
  const { data: event } = useQuery({ queryKey: ['event', id], queryFn: () => api.events.get(id) });
  const report = useQuery({ queryKey: ['report', id], queryFn: () => api.reports.event(id) });

  const checkedIn = report.data?.checkInCount ?? 0;
  const expected = report.data?.ticketsSold ?? 0;
  const pct = expected > 0 ? Math.round((checkedIn / expected) * 100) : 0;

  // Offline gate mode is shown only when the feature flag is enabled for the org.
  const offlineReadiness = useQuery({
    queryKey: ['offline-readiness', event?.organizationId],
    queryFn: () => api.offlineCheckin.offlineReadiness(event!.organizationId),
    enabled: !!event?.organizationId,
    retry: false,
  });
  const offlineEnabled =
    offlineReadiness.data?.checks.find((c) => c.key === 'flag')?.passed ?? false;

  const [sessionId, setSessionId] = useState('');
  /*
    Opens on the date being run: the one on now, or the next to come (the last one once all
    are past). "Any session" hid Admit by eye behind "Choose a session above" even for an event
    with one date, so the door's manual path looked missing.
  */
  const chosenOnce = useRef(false);
  useEffect(() => {
    if (chosenOnce.current || !event) return;
    const live = event.sessions.filter((s) => s.status !== 'CANCELLED');
    if (live.length === 0) return;
    const now = Date.now();
    const current =
      live
        .filter((s) => new Date(s.endsAt).getTime() > now)
        .sort((a, b) => a.startsAt.localeCompare(b.startsAt))[0] ??
      [...live].sort((a, b) => b.startsAt.localeCompare(a.startsAt))[0];
    chosenOnce.current = true;
    setSessionId(current.id);
  }, [event]);
  const [token, setToken] = useState('');
  /*
    A ticket number (TKT-...) or booking reference (ETG-...) typed into the scan box. Those are
    printed on the ticket, so the door types them - and the server, rightly, cannot verify one
    as a signed QR code, so it answered "Invalid". They go to Admit by eye instead.
  */
  const [lookup, setLookup] = useState<string | undefined>(undefined);
  const [typedNumber, setTypedNumber] = useState(false);
  const submitToken = () => {
    const t = token.trim();
    if (looksLikeTicketNumber(t)) {
      setOutcome(null);
      setTypedNumber(true);
      setLookup(t.toUpperCase());
      return;
    }
    setTypedNumber(false);
    scan.mutate(t);
  };
  const [outcome, setOutcome] = useState<CheckInOutcome | null>(null);
  const [history, setHistory] = useState<{ at: string; outcome: CheckInOutcome }[]>([]);
  const [scanning, setScanning] = useState(false);
  const videoRef = useRef<HTMLVideoElement>(null);

  // One place that records an admission, so a scan and an admission by eye read the same:
  // the counter refetches and the line appears under Recent scans without a reload.
  const recordAdmission = (res: CheckInOutcome) => {
    setHistory((h) => [{ at: new Date().toISOString(), outcome: res }, ...h].slice(0, 10));
    if (res.result === 'SUCCESS') {
      qc.invalidateQueries({ queryKey: ['report', id] });
      qc.invalidateQueries({ queryKey: ['attendee-lookup', id] });
    }
  };

  const scan = useMutation({
    mutationFn: (t: string) =>
      api.checkins.scan({
        token: t,
        expectedSessionId: sessionId || undefined,
        deviceInfo: 'Organizer web',
      }),
    onSuccess: (res) => {
      setOutcome(res);
      recordAdmission(res);
      if (res.result === 'SUCCESS') toast.push('Checked in.', 'success');
    },
    onError: (e) => toast.push(errorMessage(e), 'error'),
  });

  const reverse = useMutation({
    mutationFn: (ticketId: string) => api.checkins.reverse(ticketId),
    onSuccess: () => {
      toast.push('Check-in reversed.', 'success');
      setOutcome(null);
      qc.invalidateQueries({ queryKey: ['report', id] });
    },
    onError: (e) => toast.push(errorMessage(e), 'error'),
  });

  // Camera scanning (where the BarcodeDetector API is available).
  useEffect(() => {
    if (!scanning) return;
    let stream: MediaStream | null = null;
    let timer: ReturnType<typeof setInterval> | null = null;
    let cancelled = false;

    (async () => {
      if (typeof window === 'undefined' || !window.BarcodeDetector || !navigator.mediaDevices) {
        toast.push(
          'Camera scanning is not supported in this browser. Use manual entry.',
          'warning',
        );
        setScanning(false);
        return;
      }
      try {
        stream = await navigator.mediaDevices.getUserMedia({
          video: { facingMode: 'environment' },
        });
        if (cancelled) return;
        if (videoRef.current) {
          videoRef.current.srcObject = stream;
          await videoRef.current.play();
        }
        const detector = new window.BarcodeDetector({ formats: ['qr_code'] });
        timer = setInterval(async () => {
          if (!videoRef.current || scan.isPending) return;
          try {
            const codes = await detector.detect(videoRef.current);
            if (codes[0]?.rawValue) {
              const t = codes[0].rawValue;
              setToken(t);
              setScanning(false);
              scan.mutate(t);
            }
          } catch {
            /* frame not ready */
          }
        }, 700);
      } catch {
        toast.push('Could not access the camera.', 'error');
        setScanning(false);
      }
    })();

    return () => {
      cancelled = true;
      if (timer) clearInterval(timer);
      stream?.getTracks().forEach((t) => t.stop());
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scanning]);

  return (
    <div className="space-y-6">
      {!online && (
        <div
          role="alert"
          className="flex items-center gap-2 rounded-md border border-status-warning/30 bg-status-warning/10 px-4 py-2.5 text-[0.9375rem] text-status-warning"
        >
          <WifiOff className="h-4 w-4" /> You’re offline — scans will fail until the connection
          returns.
        </div>
      )}

      {/* Live attendance */}
      {report.isError ? (
        <ErrorState
          message="We couldn't load live attendance. Please try again."
          onRetry={() => report.refetch()}
        />
      ) : (
        <Card>
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <p className="text-caption uppercase tracking-wide text-text-muted">
                Live attendance
              </p>
              <p className="mt-1 text-h3 font-bold tracking-tight text-text-primary">
                {checkedIn}
                <span className="text-title font-medium text-text-muted"> / {expected}</span>
              </p>
            </div>
            <div className="text-right">
              <p className="text-title font-bold text-action-primary">{pct}%</p>
              <p className="text-caption text-text-muted">checked in</p>
            </div>
          </div>
          <div className="mt-3 h-2 overflow-hidden rounded-full bg-background-subtle">
            <div
              className="h-full rounded-full bg-action-primary transition-all duration-500"
              style={{ width: `${pct}%` }}
              role="progressbar"
              aria-label="Tickets checked in"
              aria-valuetext={`${checkedIn} of ${expected} checked in`}
              aria-valuenow={pct}
              aria-valuemin={0}
              aria-valuemax={100}
            />
          </div>
        </Card>
      )}

      <div className="grid gap-6 lg:grid-cols-2">
        <div className="space-y-4">
          <Card title="Scan a ticket">
            <div className="space-y-3">
              <Select
                id="sess"
                label="Restrict to session (optional)"
                value={sessionId}
                onChange={(e) => setSessionId(e.target.value)}
              >
                <option value="">Any session</option>
                {event?.sessions.map((s) => (
                  <option key={s.id} value={s.id}>
                    {timeAtVenue(s.startsAt, event?.venue)}
                  </option>
                ))}
              </Select>

              {scanning ? (
                <div className="space-y-2">
                  <video
                    ref={videoRef}
                    className="w-full rounded-md border border-border"
                    muted
                    playsInline
                  />
                  <Button variant="outline" className="w-full" onClick={() => setScanning(false)}>
                    Stop camera
                  </Button>
                </div>
              ) : (
                <Button variant="outline" className="w-full" onClick={() => setScanning(true)}>
                  Scan with camera
                </Button>
              )}

              <Textarea
                id="token"
                label="Or paste the QR code, or type the ticket number"
                rows={3}
                value={token}
                onChange={(e) => setToken(e.target.value)}
                placeholder="A scanner's reading, or a number such as TKT-1A2B3C"
              />
              <Button
                className="w-full"
                loading={scan.isPending}
                disabled={!token.trim()}
                onClick={submitToken}
              >
                Check in
              </Button>
              {typedNumber ? (
                <p role="status" className="text-sm text-text-secondary">
                  {sessionId
                    ? 'That is a ticket number, not a QR code. It is shown under Admit by eye: check the ticket, then press Admit.'
                    : 'That is a ticket number, not a QR code. Choose the session above, then find it under Admit by eye.'}
                </p>
              ) : null}
            </div>
          </Card>

          {outcome && (
            <Card
              key={history.length}
              className={`animate-scale-in border-l-4 ${outcome.result === 'SUCCESS' ? 'border-l-status-success' : outcome.result === 'DUPLICATE' || outcome.result === 'WRONG_SESSION' ? 'border-l-status-warning' : 'border-l-status-error'}`}
            >
              {outcome.result === 'SUCCESS' && (
                <div className="mb-3 flex flex-col items-center">
                  <span className="flex h-16 w-16 animate-scale-in items-center justify-center rounded-full bg-tint-success text-status-success">
                    <CheckCircle2 className="h-9 w-9" strokeWidth={2.25} />
                  </span>
                  <p className="mt-2 text-title font-bold text-status-success">Welcome in!</p>
                </div>
              )}
              <div className="flex items-center gap-2">
                <Badge tone={RESULT_TONE[outcome.result]}>
                  {outcome.result.replaceAll('_', ' ')}
                </Badge>
                <p className="text-sm text-text-secondary">{outcome.message}</p>
              </div>
              {outcome.ticket && (
                <div className="mt-3 space-y-1 text-sm">
                  <p className="font-medium text-text-primary">
                    {outcome.ticket.holderName ?? '—'}
                    {outcome.ticket.seatLabel && (
                      <span className="ml-2 rounded bg-background-subtle px-1.5 py-0.5 text-xs font-normal text-text-secondary">
                        Seat {outcome.ticket.seatLabel}
                      </span>
                    )}
                  </p>
                  <p className="text-text-muted">
                    {outcome.ticket.ticketType} ·{' '}
                    <span className="font-mono text-xs">{outcome.ticket.serial}</span>
                    {outcome.ticket.reference && (
                      <>
                        {' · '}
                        <span className="font-mono text-xs">{outcome.ticket.reference}</span>
                      </>
                    )}
                  </p>
                  {outcome.result === 'SUCCESS' && (
                    <Button
                      variant="danger"
                      className="mt-2"
                      loading={reverse.isPending}
                      onClick={() => reverse.mutate(outcome.ticket!.id)}
                    >
                      Reverse check-in
                    </Button>
                  )}
                </div>
              )}
            </Card>
          )}
        </div>

        <div className="space-y-4">
          {/*
            Sits beside the scanner rather than replacing it. Where a scanner is available it
            is the better evidence; where it is not — which is most Indian cinemas — this is
            what the door actually does, and it is now recorded instead of invisible.
          */}
          <AdmitByEye sessionId={sessionId} query={lookup} onAdmitted={recordAdmission} />
          <AttendeeLookup
            eventId={id}
            onReversed={() => {
              toast.push('Reversed.', 'success');
              qc.invalidateQueries({ queryKey: ['report', id] });
            }}
          />
          <Card title="Recent scans">
            {history.length === 0 ? (
              <p className="text-sm text-text-muted">No scans yet in this session.</p>
            ) : (
              <ul className="divide-y divide-border text-sm">
                {history.map((h, i) => (
                  <li key={i} className="flex items-center justify-between py-2">
                    <span className="text-text-secondary">
                      {h.outcome.ticket?.serial ?? h.outcome.result}
                    </span>
                    <span className="flex items-center gap-2 text-text-muted">
                      <Badge tone={RESULT_TONE[h.outcome.result]}>
                        {h.outcome.result.replaceAll('_', ' ')}
                      </Badge>
                      {recordedAt(h.at)}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </Card>
        </div>
      </div>

      {offlineEnabled && event && (
        <OfflineCheckin
          organizationId={event.organizationId}
          eventId={id}
          sessions={event.sessions.map((s) => ({ id: s.id, startsAt: s.startsAt }))}
        />
      )}
    </div>
  );
}

function AttendeeLookup({ eventId, onReversed }: { eventId: string; onReversed: () => void }) {
  const toast = useToast();
  const [q, setQ] = useState('');
  const [applied, setApplied] = useState('');
  const { data } = useQuery({
    queryKey: ['attendee-lookup', eventId, applied],
    queryFn: () =>
      api.events.attendees(eventId, { page: 1, pageSize: 10, q: applied || undefined }),
    enabled: !!applied,
  });
  const reverse = useMutation({
    mutationFn: (ticketId: string) => api.checkins.reverse(ticketId),
    onSuccess: onReversed,
    onError: (e) => toast.push(errorMessage(e), 'error'),
  });

  return (
    <Card title="Find attendee">
      {/* Said, because this list only finds: letting someone in is Admit by eye's button. */}
      <p className="mb-3 text-sm text-text-muted">
        Look up any ticket of this event, and undo a check-in made by mistake. To let someone in,
        use Admit by eye.
      </p>
      <form
        className="flex gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          setApplied(q);
        }}
      >
        <Input
          id="lookup"
          placeholder="Name, email, or serial…"
          value={q}
          onChange={(e) => setQ(e.target.value)}
        />
        <Button type="submit" variant="outline">
          Find
        </Button>
      </form>
      {data && (
        <ul className="mt-3 divide-y divide-border text-sm">
          {data.data.length === 0 && <li className="py-2 text-text-muted">No matches.</li>}
          {data.data.map((a) => (
            <li key={a.id} className="flex items-center justify-between py-2">
              <div>
                <p className="text-text-primary">
                  {a.attendeeName ?? a.buyerName ?? a.serial ?? a.reference}
                </p>
                <p className="text-xs text-text-muted">
                  {a.ticketType}
                  {a.seatLabel ? ` - seat ${a.seatLabel}` : ''}
                  {/* Two tickets of one booking read the same without it. */}
                  {a.serial && <span className="ml-1.5 font-mono">{a.serial}</span>}
                </p>
              </div>
              <div className="flex items-center gap-2">
                {/* The ticket's own status: what the door needs is "already in", not the order. */}
                <StatusBadge status={a.ticketStatus ?? a.bookingStatus} />
                {a.checkedIn && a.ticketId && (
                  <Button
                    variant="ghost"
                    loading={reverse.isPending && reverse.variables === a.ticketId}
                    disabled={reverse.isPending}
                    onClick={() => reverse.mutate(a.ticketId!)}
                  >
                    Reverse
                  </Button>
                )}
              </div>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}
