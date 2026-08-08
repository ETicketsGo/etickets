'use client';

import { useMutation, useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import {
  api,
  Button,
  Dialog,
  Input,
  Select,
  errorMessage,
  useToast,
  type CopyScheduleResult,
  type Screen,
} from '@eticketsgo/web-kit';
import { useOrg } from '@/components/org-context';
import { explainRejection, shiftDate } from './show-status';

/**
 * Copy a screen's day to another date and/or screen.
 *
 * Preview first, always. Copying a full day is the fastest way to fill a schedule and
 * therefore the fastest way to fill it wrongly; the operator sees the recovered times and
 * any conflicts before anything is written.
 *
 * The server recovers the source times and re-resolves them against the target date in the
 * venue's zone, so a 10:30 show stays 10:30 even across a clock change. Nothing here does
 * date arithmetic on instants.
 */
export function CopyScheduleDialog({
  screens,
  sourceDate,
  timezone,
  onClose,
  onCopied,
}: {
  screens: Screen[];
  sourceDate: string;
  timezone: string;
  onClose: () => void;
  onCopied: () => void;
}) {
  const toast = useToast();
  const [sourceScreenId, setSourceScreenId] = useState(screens[0]?.id ?? '');
  const [targetScreenId, setTargetScreenId] = useState('');
  const [targetDate, setTargetDate] = useState(shiftDate(sourceDate, 1));
  const [movieId, setMovieId] = useState('');
  const [preview, setPreview] = useState<CopyScheduleResult | null>(null);

  // The org comes from the active organizer context, not from the cinema payload — the
  // Cinema response deliberately does not carry it.
  const { activeOrg } = useOrg();
  const moviesQ = useQuery({
    queryKey: ['movies', activeOrg.id],
    queryFn: () => api.movies.list(activeOrg.id),
  });

  const body = (dryRun: boolean) => ({
    sourceScreenId,
    sourceDate,
    ...(targetScreenId ? { targetScreenId } : {}),
    targetDate,
    timezone,
    dryRun,
  });

  const previewM = useMutation({
    mutationFn: () => api.shows.copySchedule(movieId, body(true)),
    onSuccess: setPreview,
    onError: (e) => toast.push(errorMessage(e)),
  });

  const copyM = useMutation({
    mutationFn: () => api.shows.copySchedule(movieId, body(false)),
    onSuccess: (r) => {
      toast.push(`Copied ${r.created.length} show${r.created.length === 1 ? '' : 's'}.`);
      onCopied();
    },
    onError: (e) => {
      toast.push(errorMessage(e));
      onCopied();
    },
  });

  const willCreate = preview ? preview.proposed - preview.rejected.length : 0;

  return (
    <Dialog open onClose={onClose} title="Copy schedule">
      <div className="space-y-4">
        <div className="grid gap-4 sm:grid-cols-2">
          <div>
            <label htmlFor="copy-source" className="mb-1 block text-sm font-medium">
              From screen
            </label>
            <Select
              id="copy-source"
              value={sourceScreenId}
              onChange={(e) => setSourceScreenId(e.target.value)}
            >
              {screens.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                </option>
              ))}
            </Select>
            <p className="mt-1 text-xs text-slate-500">on {sourceDate}</p>
          </div>
          <div>
            <label htmlFor="copy-target-screen" className="mb-1 block text-sm font-medium">
              To screen
            </label>
            <Select
              id="copy-target-screen"
              value={targetScreenId}
              onChange={(e) => setTargetScreenId(e.target.value)}
            >
              <option value="">Same screen</option>
              {screens
                .filter((s) => s.id !== sourceScreenId)
                .map((s) => (
                  <option
                    key={s.id}
                    value={s.id}
                    disabled={Boolean(s.status && s.status !== 'ACTIVE')}
                  >
                    {s.name}
                    {s.status && s.status !== 'ACTIVE' ? ` — ${s.status.toLowerCase()}` : ''}
                  </option>
                ))}
            </Select>
          </div>
          <div>
            <label htmlFor="copy-target-date" className="mb-1 block text-sm font-medium">
              To date
            </label>
            <Input
              id="copy-target-date"
              type="date"
              value={targetDate}
              onChange={(e) => setTargetDate(e.target.value)}
            />
          </div>
          <div>
            <label htmlFor="copy-movie" className="mb-1 block text-sm font-medium">
              Movie
            </label>
            <Select id="copy-movie" value={movieId} onChange={(e) => setMovieId(e.target.value)}>
              <option value="">Choose a movie…</option>
              {(moviesQ.data ?? []).map((m) => (
                <option key={m.id} value={m.id}>
                  {m.title}
                </option>
              ))}
            </Select>
          </div>
        </div>

        <p className="rounded-md bg-slate-50 p-2 text-xs text-slate-600">
          This creates new shows. Bookings on the source day are not moved or affected.
        </p>

        {preview ? (
          <div className="space-y-3">
            <div className="rounded-md bg-slate-50 p-3 text-sm" role="status">
              Source times: <span className="font-mono">{preview.times.join(', ') || 'none'}</span>
              <div className="mt-1">
                <strong className="text-green-700">{willCreate}</strong> will be created
                {preview.rejected.length ? (
                  <>
                    {' · '}
                    <strong className="text-amber-700">{preview.rejected.length}</strong> skipped
                  </>
                ) : null}
              </div>
            </div>
            {preview.rejected.length ? (
              <ul className="space-y-2">
                {preview.rejected.map((r, i) => (
                  <li
                    key={`${r.startsAt}-${i}`}
                    className="rounded-md border border-amber-200 bg-amber-50 p-2 text-sm"
                  >
                    {explainRejection(r, preview.turnaroundMinutes)}
                    <span className="ml-2 font-mono text-xs text-slate-400">{r.reason}</span>
                  </li>
                ))}
              </ul>
            ) : null}
            {preview.proposed === 0 ? (
              <p className="text-sm text-slate-600">
                Nothing is scheduled on {sourceDate} for that screen and movie.
              </p>
            ) : null}
          </div>
        ) : null}

        <div className="flex justify-end gap-2 pt-2">
          <Button variant="secondary" onClick={onClose} disabled={copyM.isPending}>
            Cancel
          </Button>
          <Button
            variant="secondary"
            onClick={() => previewM.mutate()}
            disabled={!sourceScreenId || !movieId || previewM.isPending}
          >
            {previewM.isPending ? 'Checking…' : 'Preview'}
          </Button>
          <Button
            onClick={() => copyM.mutate()}
            disabled={!preview || willCreate === 0 || copyM.isPending}
          >
            {copyM.isPending ? 'Copying…' : `Copy ${willCreate} show${willCreate === 1 ? '' : 's'}`}
          </Button>
        </div>
      </div>
    </Dialog>
  );
}
