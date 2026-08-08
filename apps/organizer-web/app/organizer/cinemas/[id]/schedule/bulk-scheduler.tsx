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
  type BulkScheduleResult,
  type Screen,
} from '@eticketsgo/web-kit';
import { useOrg } from '@/components/org-context';
import { explainRejection } from './show-status';

/**
 * Create shows in bulk: Configure → Preview → Publish.
 *
 * Preview is not skippable. The server defaults `dryRun` to true and this always sends it
 * explicitly, so a mis-click cannot create forty shows. An operator filling a week needs to
 * see exactly which slots are refused and why BEFORE anything is written — discovering
 * conflicts one failed request at a time is how a schedule ends up half-built.
 *
 * No overlap arithmetic happens here. The preview is literally the server's dry-run answer.
 */
export function BulkScheduler({
  screens,
  defaultDate,
  timezone,
  onClose,
  onPublished,
}: {
  screens: Screen[];
  defaultDate: string;
  timezone: string;
  onClose: () => void;
  onPublished: () => void;
}) {
  const toast = useToast();
  const [step, setStep] = useState<'configure' | 'preview'>('configure');

  const [screenId, setScreenId] = useState(screens[0]?.id ?? '');
  const [movieId, setMovieId] = useState('');
  const [mode, setMode] = useState<'single' | 'range'>('single');
  const [from, setFrom] = useState(defaultDate);
  const [to, setTo] = useState(defaultDate);
  const [timesText, setTimesText] = useState('09:00\n12:45\n16:30\n20:15');
  const [padMinutes, setPadMinutes] = useState('20');
  const [preview, setPreview] = useState<BulkScheduleResult | null>(null);

  // The org comes from the active organizer context, not from the cinema payload — the
  // Cinema response deliberately does not carry it.
  const { activeOrg } = useOrg();
  const moviesQ = useQuery({
    queryKey: ['movies', activeOrg.id],
    queryFn: () => api.movies.list(activeOrg.id),
  });

  const times = timesText
    .split(/[\n,]/)
    .map((t) => t.trim())
    .filter(Boolean);
  const invalidTimes = times.filter((t) => !/^([01]\d|2[0-3]):[0-5]\d$/.test(t));

  const body = () => ({
    screenId,
    ...(mode === 'single' ? { dates: [from] } : { from, to }),
    times,
    padMinutes: Number(padMinutes) || 0,
    timezone,
    dryRun: true,
  });

  const previewM = useMutation({
    mutationFn: () => api.shows.bulkSchedule(movieId, body()),
    onSuccess: (r) => {
      setPreview(r);
      setStep('preview');
    },
    onError: (e) => toast.push(errorMessage(e)),
  });

  const publishM = useMutation({
    mutationFn: () => api.shows.bulkSchedule(movieId, { ...body(), dryRun: false }),
    onSuccess: (r) => {
      toast.push(
        `Created ${r.created.length} show${r.created.length === 1 ? '' : 's'}${
          r.rejected.length ? `, skipped ${r.rejected.length}` : ''
        }.`,
      );
      onPublished();
    },
    onError: (e) => {
      toast.push(errorMessage(e));
      // The write may have partly happened from the caller's point of view even though the
      // server is transactional — refreshing is cheaper than guessing.
      onPublished();
    },
  });

  const canPreview = screenId && movieId && times.length > 0 && invalidTimes.length === 0;

  return (
    <Dialog open onClose={onClose} title="Create shows">
      <ol className="mb-4 flex gap-4 text-sm" aria-label="Progress">
        <li aria-current={step === 'configure' ? 'step' : undefined}>
          <span className={step === 'configure' ? 'font-semibold' : 'text-slate-400'}>
            1. Configure
          </span>
        </li>
        <li aria-current={step === 'preview' ? 'step' : undefined}>
          <span className={step === 'preview' ? 'font-semibold' : 'text-slate-400'}>
            2. Preview
          </span>
        </li>
        <li>
          <span className="text-slate-400">3. Publish</span>
        </li>
      </ol>

      {step === 'configure' ? (
        <div className="space-y-4">
          <div className="grid gap-4 sm:grid-cols-2">
            <div>
              <label htmlFor="bulk-screen" className="mb-1 block text-sm font-medium">
                Screen
              </label>
              <Select
                id="bulk-screen"
                value={screenId}
                onChange={(e) => setScreenId(e.target.value)}
              >
                {screens.map((s) => (
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
              <label htmlFor="bulk-movie" className="mb-1 block text-sm font-medium">
                Movie
              </label>
              <Select id="bulk-movie" value={movieId} onChange={(e) => setMovieId(e.target.value)}>
                <option value="">Choose a movie…</option>
                {(moviesQ.data ?? []).map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.title} ({m.runtimeMinutes} min)
                  </option>
                ))}
              </Select>
            </div>
          </div>

          <fieldset>
            <legend className="mb-1 text-sm font-medium">Dates</legend>
            <div className="flex flex-wrap items-end gap-3">
              <Select
                aria-label="Date mode"
                value={mode}
                onChange={(e) => setMode(e.target.value as 'single' | 'range')}
              >
                <option value="single">One date</option>
                <option value="range">Date range (daily)</option>
              </Select>
              <div>
                <label htmlFor="bulk-from" className="mb-1 block text-xs text-slate-500">
                  {mode === 'single' ? 'Date' : 'From'}
                </label>
                <Input
                  id="bulk-from"
                  type="date"
                  value={from}
                  onChange={(e) => setFrom(e.target.value)}
                />
              </div>
              {mode === 'range' ? (
                <div>
                  <label htmlFor="bulk-to" className="mb-1 block text-xs text-slate-500">
                    To
                  </label>
                  <Input
                    id="bulk-to"
                    type="date"
                    value={to}
                    onChange={(e) => setTo(e.target.value)}
                  />
                </div>
              ) : null}
            </div>
          </fieldset>

          <div>
            <label htmlFor="bulk-times" className="mb-1 block text-sm font-medium">
              Showtimes (one per line, 24-hour)
            </label>
            <textarea
              id="bulk-times"
              className="w-full rounded-md border border-slate-300 p-2 font-mono text-sm"
              rows={5}
              value={timesText}
              onChange={(e) => setTimesText(e.target.value)}
              aria-describedby="bulk-times-help"
            />
            <p id="bulk-times-help" className="mt-1 text-xs text-slate-500">
              Local time at the cinema. End times are worked out from the film&rsquo;s runtime.
            </p>
            {invalidTimes.length ? (
              <p role="alert" className="mt-1 text-sm text-red-600">
                Not valid 24-hour times: {invalidTimes.join(', ')}
              </p>
            ) : null}
          </div>

          <div className="w-40">
            <label htmlFor="bulk-pad" className="mb-1 block text-sm font-medium">
              Trailers (min)
            </label>
            <Input
              id="bulk-pad"
              type="number"
              min={0}
              max={120}
              value={padMinutes}
              onChange={(e) => setPadMinutes(e.target.value)}
            />
          </div>

          <div className="flex justify-end gap-2 pt-2">
            <Button variant="secondary" onClick={onClose}>
              Cancel
            </Button>
            <Button onClick={() => previewM.mutate()} disabled={!canPreview || previewM.isPending}>
              {previewM.isPending ? 'Checking…' : 'Preview'}
            </Button>
          </div>
        </div>
      ) : (
        <PreviewStep
          preview={preview}
          timezone={timezone}
          publishing={publishM.isPending}
          onBack={() => setStep('configure')}
          onPublish={() => publishM.mutate()}
        />
      )}
    </Dialog>
  );
}

/**
 * The server's dry-run answer, rendered so an operator can act on it.
 *
 * If 40 slots are proposed and 3 refused, the point of this screen is that they can see
 * exactly which 3 and why, in one pass.
 */
function PreviewStep({
  preview,
  timezone,
  publishing,
  onBack,
  onPublish,
}: {
  preview: BulkScheduleResult | null;
  timezone: string;
  publishing: boolean;
  onBack: () => void;
  onPublish: () => void;
}) {
  if (!preview) return null;
  const willCreate = preview.proposed - preview.rejected.length;

  return (
    <div className="space-y-4">
      <div className="rounded-md bg-slate-50 p-3 text-sm" role="status">
        <strong>{preview.proposed}</strong> slot{preview.proposed === 1 ? '' : 's'} proposed
        {' · '}
        <strong className="text-green-700">{willCreate}</strong> will be created
        {preview.rejected.length ? (
          <>
            {' · '}
            <strong className="text-amber-700">{preview.rejected.length}</strong> will be skipped
          </>
        ) : null}
        <div className="mt-1 text-xs text-slate-500">
          Screens need {preview.turnaroundMinutes} min between shows.
        </div>
      </div>

      {preview.rejected.length ? (
        <div>
          <h4 className="mb-2 text-sm font-semibold">These will be skipped</h4>
          <ul className="space-y-2">
            {preview.rejected.map((r, i) => (
              <li
                key={`${r.startsAt}-${i}`}
                className="rounded-md border border-amber-200 bg-amber-50 p-2 text-sm"
              >
                {explainRejection(r, preview.turnaroundMinutes, timezone)}
                {/* The raw code stays visible for diagnostics without being the message. */}
                <span className="ml-2 font-mono text-xs text-slate-400">{r.reason}</span>
              </li>
            ))}
          </ul>
        </div>
      ) : (
        <p className="text-sm text-green-700">No conflicts — every slot is free.</p>
      )}

      <div className="flex justify-end gap-2 pt-2">
        <Button variant="secondary" onClick={onBack} disabled={publishing}>
          Back
        </Button>
        <Button onClick={onPublish} disabled={publishing || willCreate === 0}>
          {publishing ? 'Creating…' : `Publish ${willCreate} show${willCreate === 1 ? '' : 's'}`}
        </Button>
      </div>
    </div>
  );
}
