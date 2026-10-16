'use client';

import { useQuery } from '@tanstack/react-query';
import { api, Card, Skeleton, recordedAt } from '@eticketsgo/web-kit';
import { historyLines, type HistoryEntry } from '../lib/history';

/** The audit entries for these records, as `Type:id` pairs. See `lib/history.ts`. */
export function useRecordHistory(subjects: string[]) {
  const key = subjects.filter(Boolean).slice(0, 20).join(',');
  return useQuery({
    queryKey: ['admin', 'audit', 'subjects', key],
    queryFn: () => api.admin.audit({ subjects: key, page: 1, pageSize: 50 }),
    enabled: key.length > 0,
    // Somebody without BOOKING_READ is refused the log; the page still works without it.
    retry: false,
  });
}

/**
 * "What happened", oldest first, from the audit log.
 *
 * Read-only and never the only place a fact appears: the record's own fields above it stay the
 * source of truth, and this explains how it got there.
 */
export function RecordHistory({
  subjects,
  title = 'What happened',
}: {
  subjects: string[];
  title?: string;
}) {
  const q = useRecordHistory(subjects);
  if (q.isError) return null;
  const lines = historyLines((q.data?.data ?? []) as HistoryEntry[]);
  return (
    <Card title={title}>
      {q.isLoading ? (
        <Skeleton className="h-20 w-full" />
      ) : lines.length === 0 ? (
        <p className="text-sm text-text-muted">Nothing has been recorded about this yet.</p>
      ) : (
        <ol className="space-y-3">
          {lines.map((line, i) => (
            <li key={i} className="flex gap-3 text-sm">
              <span
                aria-hidden
                className={`mt-1.5 h-2 w-2 shrink-0 rounded-full ${
                  line.problem ? 'bg-status-error' : 'bg-action-primary'
                }`}
              />
              <div className="min-w-0">
                <p className={line.problem ? 'text-status-error' : 'text-text-primary'}>
                  {line.text}
                </p>
                {line.detail && (
                  <p className="break-words text-caption text-text-secondary [overflow-wrap:anywhere]">
                    {line.detail}
                  </p>
                )}
                <p className="text-caption text-text-muted">
                  {recordedAt(line.when)} - {line.who}
                </p>
              </div>
            </li>
          ))}
        </ol>
      )}
    </Card>
  );
}
