'use client';

import { useState } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import { useParams } from 'next/navigation';
import { Sparkles, TrendingUp, AlertTriangle, Send, Lightbulb } from 'lucide-react';
import {
  api,
  Card,
  Button,
  Input,
  Skeleton,
  ErrorState,
  useToast,
  errorMessage,
} from '@eticketsgo/web-kit';
import { useOrg } from '@/components/org-context';

const LEVEL_STYLE: Record<string, string> = {
  warning: 'border-status-warning/30 bg-status-warning/5',
  positive: 'border-status-success/30 bg-status-success/5',
  info: 'border-action-primary/30 bg-action-primary/5',
};
const EVIDENCE_LABEL: Record<string, string> = {
  strong: 'Strong evidence',
  moderate: 'Moderate evidence',
  weak: 'Early signal',
};

const SUGGESTED = [
  'How are ticket sales performing?',
  'Which ticket type is selling best?',
  'What is the refund rate?',
  'What should I review before the event?',
  "Summarize today's sales",
];

export default function AssistantTab() {
  const { id } = useParams<{ id: string }>();
  const { activeOrg } = useOrg();
  const toast = useToast();
  const [question, setQuestion] = useState('');
  const [answer, setAnswer] = useState<{ answer: string; aiEnabled: boolean } | null>(null);

  const summaryQ = useQuery({
    queryKey: ['ai-summary', id],
    queryFn: () => api.ai.eventSummary(id),
  });
  const recsQ = useQuery({
    queryKey: ['ai-recs', id],
    queryFn: () => api.ai.recommendations(id),
  });

  const ask = useMutation({
    mutationFn: (q: string) => api.ai.ask(activeOrg.id, q),
    onSuccess: (res) => setAnswer(res),
    onError: (e) => toast.push(errorMessage(e), 'error'),
  });

  const submit = (q: string) => {
    const value = q.trim();
    if (!value) return;
    setQuestion(value);
    ask.mutate(value);
  };

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-2">
        <Sparkles className="h-5 w-5 text-action-primary" />
        <div>
          <h2 className="text-title font-semibold text-text-primary">Assistant</h2>
          <p className="text-caption text-text-secondary">
            Suggestions based on your current data. Advisory only — you decide what to act on.
          </p>
        </div>
      </div>

      {/* Ask */}
      <Card title="Ask about this organization">
        <div className="flex flex-col gap-2 sm:flex-row">
          <Input
            id="ai-question"
            aria-label="Ask about this organization"
            className="flex-1"
            placeholder="e.g. How are ticket sales performing?"
            value={question}
            onChange={(e) => setQuestion(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && submit(question)}
          />
          <Button loading={ask.isPending} onClick={() => submit(question)}>
            <Send className="h-4 w-4" /> Ask
          </Button>
        </div>
        <div className="mt-3 flex flex-wrap gap-2">
          {SUGGESTED.map((s) => (
            <button
              key={s}
              onClick={() => submit(s)}
              className="rounded-full border border-border px-3 py-1 text-caption text-text-secondary hover:border-border-strong hover:text-text-primary"
            >
              {s}
            </button>
          ))}
        </div>
        {answer && (
          <div className="mt-4 rounded-xl border border-action-primary/30 bg-action-primary/5 p-4">
            <p className="text-[0.9375rem] text-text-primary">{answer.answer}</p>
            <p className="mt-2 text-caption text-text-muted">
              Based on your current data{answer.aiEnabled ? '' : ' (deterministic)'}.
            </p>
          </div>
        )}
      </Card>

      {/* Summary */}
      <Card title="Event summary">
        {summaryQ.isError ? (
          <ErrorState message="Couldn't load the summary." onRetry={() => summaryQ.refetch()} />
        ) : summaryQ.isLoading || !summaryQ.data ? (
          <Skeleton className="h-40 w-full" />
        ) : (
          <div className="space-y-3">
            <p className="font-medium text-text-primary">{summaryQ.data.summary.headline}</p>
            <div className="grid gap-2 sm:grid-cols-2">
              {summaryQ.data.summary.sections.map((s) => (
                <div
                  key={s.key}
                  className={`rounded-lg border px-3 py-2 ${LEVEL_STYLE[s.level] ?? ''}`}
                >
                  <p className="text-caption font-semibold text-text-secondary">{s.label}</p>
                  <p className="text-[0.9375rem] text-text-primary">{s.text}</p>
                </div>
              ))}
            </div>
          </div>
        )}
      </Card>

      {/* Growth recommendations */}
      <Card title="Growth recommendations">
        {recsQ.isError ? (
          <ErrorState message="Couldn't load recommendations." onRetry={() => recsQ.refetch()} />
        ) : recsQ.isLoading || !recsQ.data ? (
          <Skeleton className="h-32 w-full" />
        ) : recsQ.data.recommendations.length === 0 ? (
          <div className="flex items-center gap-2 text-[0.9375rem] text-text-muted">
            <Lightbulb className="h-4 w-4" /> No suggestions right now — your event looks healthy.
          </div>
        ) : (
          <ul className="space-y-3">
            {recsQ.data.recommendations.map((r) => (
              <li key={r.key} className="rounded-xl border border-border p-4">
                <div className="flex items-start gap-3">
                  <TrendingUp className="mt-0.5 h-4 w-4 shrink-0 text-action-primary" />
                  <div className="min-w-0 flex-1">
                    <p className="font-semibold text-text-primary">{r.title}</p>
                    <p className="mt-0.5 text-caption text-text-muted">{r.metric}</p>
                    <p className="mt-1.5 text-[0.9375rem] text-text-secondary">{r.reason}</p>
                    <p className="mt-1.5 text-[0.9375rem] text-text-primary">
                      <span className="font-medium">Consider:</span> {r.action}
                    </p>
                    <span className="mt-2 inline-flex items-center gap-1 rounded-full bg-background-subtle px-2 py-0.5 text-caption text-text-muted">
                      <AlertTriangle className="h-3 w-3" />{' '}
                      {EVIDENCE_LABEL[r.evidence] ?? r.evidence}
                    </span>
                  </div>
                </div>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </div>
  );
}
