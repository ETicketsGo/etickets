'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
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
  useToast,
  useOnline,
  errorMessage,
  dateTime,
  type CheckInOutcome,
  type BadgeTone,
} from '@eticketsgo/web-kit';

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

  const [sessionId, setSessionId] = useState('');
  const [token, setToken] = useState('');
  const [outcome, setOutcome] = useState<CheckInOutcome | null>(null);
  const [history, setHistory] = useState<{ at: string; outcome: CheckInOutcome }[]>([]);
  const [scanning, setScanning] = useState(false);
  const videoRef = useRef<HTMLVideoElement>(null);

  const scan = useMutation({
    mutationFn: (t: string) =>
      api.checkins.scan({
        token: t,
        expectedSessionId: sessionId || undefined,
        deviceInfo: 'Organizer web',
      }),
    onSuccess: (res) => {
      setOutcome(res);
      setHistory((h) => [{ at: new Date().toISOString(), outcome: res }, ...h].slice(0, 10));
      if (res.result === 'SUCCESS') {
        toast.push('Checked in.', 'success');
        qc.invalidateQueries({ queryKey: ['report', id] });
      }
    },
    onError: (e) => toast.push(errorMessage(e), 'error'),
  });

  const reverse = useMutation({
    mutationFn: (ticketId: string) => api.checkins.reverse(ticketId),
    onSuccess: () => {
      toast.push('Check-in reversed.', 'success');
      setOutcome(null);
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
      <Card>
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <p className="text-caption uppercase tracking-wide text-text-muted">Live attendance</p>
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
            aria-valuenow={pct}
            aria-valuemin={0}
            aria-valuemax={100}
          />
        </div>
      </Card>

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
                    {dateTime(s.startsAt)}
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
                label="Or paste QR token"
                rows={3}
                value={token}
                onChange={(e) => setToken(e.target.value)}
                placeholder="Paste the scanned QR value…"
              />
              <Button
                className="w-full"
                loading={scan.isPending}
                disabled={!token.trim()}
                onClick={() => scan.mutate(token.trim())}
              >
                Check in
              </Button>
            </div>
          </Card>

          {outcome && (
            <Card
              key={history.length}
              className={`animate-scale-in border-l-4 ${outcome.result === 'SUCCESS' ? 'border-l-status-success' : outcome.result === 'DUPLICATE' || outcome.result === 'WRONG_SESSION' ? 'border-l-status-warning' : 'border-l-status-error'}`}
            >
              {outcome.result === 'SUCCESS' && (
                <div className="mb-3 flex flex-col items-center">
                  <span className="flex h-16 w-16 animate-scale-in items-center justify-center rounded-full bg-status-success/15 text-status-success">
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
                  </p>
                  <p className="text-text-muted">
                    {outcome.ticket.ticketType} ·{' '}
                    <span className="font-mono text-xs">{outcome.ticket.serial}</span>
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
          <AttendeeLookup eventId={id} onReversed={() => toast.push('Reversed.', 'success')} />
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
                      {dateTime(h.at)}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </Card>
        </div>
      </div>
    </div>
  );
}

function AttendeeLookup({ eventId, onReversed }: { eventId: string; onReversed: () => void }) {
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
  });

  return (
    <Card title="Find attendee">
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
                <p className="text-text-primary">{a.holderName ?? a.serial}</p>
                <p className="text-xs text-text-muted">{a.ticketType}</p>
              </div>
              <div className="flex items-center gap-2">
                <StatusBadge status={a.status} />
                {a.status === 'CHECKED_IN' && (
                  <Button variant="ghost" onClick={() => reverse.mutate(a.id)}>
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
