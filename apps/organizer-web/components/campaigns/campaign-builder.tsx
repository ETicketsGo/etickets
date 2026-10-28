'use client';

import { useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowDown, ArrowUp, Monitor, Smartphone, Trash2 } from 'lucide-react';
import {
  api,
  Button,
  Card,
  ErrorState,
  Input,
  PageHeader,
  Select,
  Skeleton,
  Stepper,
  Textarea,
  dateTime,
  errorMessage,
  useToast,
  type Campaign,
  type CampaignAudienceDefinition,
  type CampaignBlock,
  type CampaignPurpose,
  type CampaignTemplateKey,
  type CampaignsStatus,
  type QuietHours,
} from '@eticketsgo/web-kit';
import { useOrg } from '@/components/org-context';
import {
  BUILDER_STEPS,
  COMMON_TIME_ZONES,
  PURPOSE_WORDS,
  SOURCE_WORDS,
  audienceProblems,
  campaignGate,
  designProblems,
  newBlock,
  setupProblems,
  zonedLocalToIso,
} from '@/lib/campaigns';
import { AudienceCounts, CampaignGateNotice, SendingModeNote } from './campaign-ui';

interface Draft {
  name: string;
  subject: string;
  previewText: string;
  senderName: string;
  replyTo: string;
  purpose: CampaignPurpose;
  templateKey: CampaignTemplateKey;
  eventId: string;
  locale: 'en' | 'fr-CA';
  audience: CampaignAudienceDefinition;
  blocks: CampaignBlock[];
  timezone: string;
  quietOn: boolean;
  quiet: QuietHours;
}

function fromCampaign(c: Campaign): Draft {
  return {
    name: c.name,
    subject: c.subject,
    previewText: c.previewText ?? '',
    senderName: c.senderName,
    replyTo: c.replyTo ?? '',
    purpose: c.purpose,
    templateKey: c.templateKey,
    eventId: c.eventId ?? '',
    locale: c.locale,
    audience: c.audience,
    blocks: c.content.blocks,
    timezone: c.timezone,
    quietOn: !!c.quietHours,
    quiet: c.quietHours ?? { start: '21:00', end: '08:00' },
  };
}

function browserZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  } catch {
    return 'UTC';
  }
}

function Problems({ items }: { items: string[] }) {
  if (!items.length) return null;
  return (
    <ul
      className="space-y-1 rounded-md bg-tint-warning p-3 text-ui text-status-warning"
      role="alert"
    >
      {items.map((p) => (
        <li key={p}>{p}</li>
      ))}
    </ul>
  );
}

/**
 * The five-step campaign builder: Setup, Audience, Design, Schedule, Review.
 *
 * Each step saves the draft (optimistic lock: the version read is the version written). The
 * Review step asks the API for the final checks and a confirmation token; Send and Schedule
 * need that token, so what was reviewed is exactly what goes.
 */
export function CampaignBuilder({
  campaignId,
  initialStep = 0,
}: {
  campaignId?: string;
  initialStep?: number;
}) {
  const { activeOrg } = useOrg();
  const router = useRouter();
  const toast = useToast();
  const qc = useQueryClient();
  const [step, setStep] = useState(campaignId ? initialStep : 0);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [version, setVersion] = useState<number | null>(null);
  const [saving, setSaving] = useState(false);
  const [problems, setProblems] = useState<string[]>([]);

  const status = useQuery({
    queryKey: ['campaigns-status', activeOrg.id],
    queryFn: () => api.campaigns.status(activeOrg.id),
  });
  const gate = campaignGate(status.data);
  const events = useQuery({
    queryKey: ['org-events', activeOrg.id],
    queryFn: () => api.events.list(activeOrg.id),
    enabled: gate.kind === 'ready',
  });
  const campaign = useQuery({
    queryKey: ['campaign', activeOrg.id, campaignId],
    queryFn: () => api.campaigns.get(activeOrg.id, campaignId!),
    enabled: !!campaignId && gate.kind === 'ready',
  });

  useEffect(() => {
    if (campaign.data && !draft) {
      if (campaign.data.status !== 'DRAFT') {
        router.replace(`/organizer/campaigns/${campaign.data.id}`);
        return;
      }
      setDraft(fromCampaign(campaign.data));
      setVersion(campaign.data.version);
    }
  }, [campaign.data, draft, router]);

  useEffect(() => {
    if (!campaignId && !draft && status.data) {
      const first = status.data.templates[0];
      setDraft({
        name: '',
        subject: '',
        previewText: '',
        senderName: activeOrg.name,
        replyTo: '',
        purpose: first?.purpose ?? 'ORGANIZER_UPDATES',
        templateKey: first?.key ?? 'EVENT_ANNOUNCEMENT',
        eventId: '',
        locale: 'en',
        audience: { sources: ['FOLLOWERS'] },
        blocks: [],
        timezone: browserZone(),
        quietOn: true,
        quiet: status.data.defaults.quietHours,
      });
    }
  }, [campaignId, draft, status.data, activeOrg.name]);

  const set = (patch: Partial<Draft>) => setDraft((d) => (d ? { ...d, ...patch } : d));

  if (status.isLoading || (campaignId && campaign.isLoading) || !draft) {
    if (status.isError || campaign.isError) {
      return (
        <ErrorState message="We could not open this campaign." onRetry={() => campaign.refetch()} />
      );
    }
    if (status.data && gate.kind !== 'ready') return <CampaignGateNotice gate={gate} />;
    return <Skeleton className="h-96 w-full" />;
  }
  if (gate.kind !== 'ready') return <CampaignGateNotice gate={gate} />;

  const template = status.data!.templates.find((t) => t.key === draft.templateKey);

  /** Save what this step owns. Creates the draft on the first step. */
  async function save(next?: number) {
    if (!draft) return;
    const stepProblems =
      step === 0
        ? [
            ...(campaignId ? setupProblems(draft) : []),
            ...(template?.needsEvent && !draft.eventId
              ? ['Choose the event this email is about.']
              : []),
          ]
        : step === 1
          ? audienceProblems(draft.audience)
          : step === 2
            ? designProblems(draft.blocks)
            : [];
    setProblems(stepProblems);
    if (stepProblems.length) return;
    setSaving(true);
    try {
      if (!campaignId) {
        const created = await api.campaigns.create(activeOrg.id, {
          templateKey: draft.templateKey,
          eventId: draft.eventId || null,
          ...(draft.name.trim() ? { name: draft.name.trim() } : {}),
          ...(draft.subject.trim() ? { subject: draft.subject.trim() } : {}),
          ...(draft.previewText.trim() ? { previewText: draft.previewText.trim() } : {}),
          senderName: draft.senderName.trim() || activeOrg.name,
          replyTo: draft.replyTo.trim() || null,
          purpose: draft.purpose,
          locale: draft.locale,
          timezone: draft.timezone,
          quietHours: draft.quietOn ? draft.quiet : null,
        });
        toast.push('Draft saved.', 'success');
        router.replace(`/organizer/campaigns/${created.id}/edit?step=1`);
        return;
      }
      const updated = await api.campaigns.update(activeOrg.id, campaignId, {
        version: version!,
        name: draft.name.trim(),
        subject: draft.subject.trim(),
        previewText: draft.previewText.trim() || null,
        senderName: draft.senderName.trim(),
        replyTo: draft.replyTo.trim() || null,
        purpose: draft.purpose,
        eventId: draft.eventId || null,
        locale: draft.locale,
        audience: draft.audience,
        content: { blocks: draft.blocks },
        timezone: draft.timezone,
        quietHours: draft.quietOn ? draft.quiet : null,
      });
      setVersion(updated.version);
      qc.setQueryData(['campaign', activeOrg.id, campaignId], updated);
      if (typeof next === 'number') setStep(next);
    } catch (err) {
      setProblems([errorMessage(err)]);
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="space-y-6">
      <PageHeader
        title={campaignId ? draft.name || 'Campaign' : 'New campaign'}
        description="Five steps. Nothing is sent until you confirm on the last one."
        breadcrumbs={[
          { label: 'Email campaigns', href: '/organizer/campaigns' },
          { label: 'Builder' },
        ]}
      />
      <Stepper steps={[...BUILDER_STEPS]} current={step} label="Campaign steps" />
      <Problems items={problems} />

      {step === 0 && (
        <SetupStep
          draft={draft}
          set={set}
          status={status.data!}
          events={events.data ?? []}
          isNew={!campaignId}
        />
      )}
      {step === 1 && campaignId && (
        <AudienceStep
          orgId={activeOrg.id}
          draft={draft}
          set={set}
          status={status.data!}
          events={events.data ?? []}
        />
      )}
      {step === 2 && campaignId && (
        <DesignStep
          orgId={activeOrg.id}
          campaignId={campaignId}
          draft={draft}
          set={set}
          events={events.data ?? []}
          version={version}
          onSave={() => save()}
        />
      )}
      {step === 3 && campaignId && <ScheduleStep draft={draft} set={set} />}
      {step === 4 && campaignId && version !== null && (
        <ReviewStep
          orgId={activeOrg.id}
          campaignId={campaignId}
          draft={draft}
          canSchedule={status.data!.entitlements.schedule}
          onDone={(id) => {
            // The builder and the detail page share this cache entry; after scheduling or sending
            // the server moved status and version, so drop the builder's copy before showing it.
            void qc.invalidateQueries({ queryKey: ['campaign', activeOrg.id, id] });
            void qc.invalidateQueries({ queryKey: ['campaigns', activeOrg.id] });
            router.push(`/organizer/campaigns/${id}`);
          }}
        />
      )}

      <div className="flex flex-wrap justify-between gap-3">
        <Button
          variant="outline"
          disabled={step === 0 || saving}
          onClick={() => setStep((s) => Math.max(0, s - 1))}
        >
          Back
        </Button>
        {step < 4 && (
          <Button loading={saving} onClick={() => save(step + 1)}>
            {campaignId ? 'Save and continue' : 'Create draft'}
          </Button>
        )}
      </div>
    </div>
  );
}

// ── Steps ──────────────────────────────────────────────────────────────────────────────

type EventRow = { id: string; title: string; status: string };

function SetupStep({
  draft,
  set,
  status,
  events,
  isNew,
}: {
  draft: Draft;
  set: (p: Partial<Draft>) => void;
  status: CampaignsStatus;
  events: EventRow[];
  isNew: boolean;
}) {
  return (
    <Card title="Setup">
      <div className="space-y-5">
        {isNew && (
          <fieldset>
            <legend className="text-ui font-medium text-text-primary">Start from a template</legend>
            <div className="mt-2 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
              {status.templates.map((t) => (
                <label
                  key={t.key}
                  className={`cursor-pointer rounded-lg border p-4 ${
                    draft.templateKey === t.key
                      ? 'border-action-primary bg-tint-primary'
                      : 'border-border'
                  }`}
                >
                  <input
                    type="radio"
                    name="template"
                    className="sr-only"
                    checked={draft.templateKey === t.key}
                    onChange={() => set({ templateKey: t.key, purpose: t.purpose })}
                  />
                  <span className="block font-semibold text-text-primary">{t.label}</span>
                  <span className="mt-1 block text-caption text-text-secondary">
                    {t.description}
                  </span>
                </label>
              ))}
            </div>
          </fieldset>
        )}
        <Select
          label="Event"
          hint="The event this email is about. Leave empty for a general email."
          value={draft.eventId}
          onChange={(e) => set({ eventId: e.target.value })}
        >
          <option value="">No event</option>
          {events.map((e) => (
            <option key={e.id} value={e.id}>
              {e.title}
            </option>
          ))}
        </Select>
        <Input
          label="Campaign name"
          hint={
            isNew
              ? 'Only you see this. Leave empty to use the template name.'
              : 'Only you see this.'
          }
          value={draft.name}
          maxLength={120}
          onChange={(e) => set({ name: e.target.value })}
        />
        <Input
          label="Subject line"
          hint={isNew ? 'Leave empty to start from the template subject.' : undefined}
          value={draft.subject}
          maxLength={150}
          onChange={(e) => set({ subject: e.target.value })}
        />
        <Input
          label="Preview text"
          hint="The short line inboxes show next to the subject."
          value={draft.previewText}
          maxLength={200}
          onChange={(e) => set({ previewText: e.target.value })}
        />
        <div className="grid gap-4 sm:grid-cols-2">
          <Input
            label="Sender name"
            hint='People see "<name> via ETicketsGo".'
            value={draft.senderName}
            maxLength={60}
            onChange={(e) => set({ senderName: e.target.value })}
          />
          <Input
            label="Reply-to address (optional)"
            type="email"
            value={draft.replyTo}
            onChange={(e) => set({ replyTo: e.target.value })}
          />
        </div>
        <div className="grid gap-4 sm:grid-cols-2">
          <Select
            label="Kind of email"
            hint={PURPOSE_WORDS[draft.purpose].hint}
            value={draft.purpose}
            onChange={(e) => set({ purpose: e.target.value as CampaignPurpose })}
          >
            {(Object.keys(PURPOSE_WORDS) as CampaignPurpose[]).map((p) => (
              <option key={p} value={p}>
                {PURPOSE_WORDS[p].label}
              </option>
            ))}
          </Select>
          <Select
            label="Language of the email footer"
            value={draft.locale}
            onChange={(e) => set({ locale: e.target.value as 'en' | 'fr-CA' })}
          >
            <option value="en">English</option>
            <option value="fr-CA">French (Canada)</option>
          </Select>
        </div>
      </div>
    </Card>
  );
}

function AudienceStep({
  orgId,
  draft,
  set,
  status,
  events,
}: {
  orgId: string;
  draft: Draft;
  set: (p: Partial<Draft>) => void;
  status: CampaignsStatus;
  events: EventRow[];
}) {
  const [citiesText, setCitiesText] = useState((draft.audience.cities ?? []).join(', '));
  const [debounced, setDebounced] = useState(draft.audience);
  useEffect(() => {
    const t = setTimeout(() => setDebounced(draft.audience), 400);
    return () => clearTimeout(t);
  }, [draft.audience]);
  const ok = audienceProblems(debounced).length === 0;
  const counts = useQuery({
    queryKey: ['audience-preview', orgId, debounced, draft.purpose],
    queryFn: () =>
      api.campaigns.previewAudience(orgId, { audience: debounced, purpose: draft.purpose }),
    enabled: ok,
  });
  const segments = useQuery({
    queryKey: ['campaign-segments', orgId],
    queryFn: () => api.campaigns.segments(orgId),
    enabled: status.entitlements.audienceAdvanced,
  });
  const toggle = (source: CampaignAudienceDefinition['sources'][number]) => {
    const has = draft.audience.sources.includes(source);
    set({
      audience: {
        ...draft.audience,
        sources: has
          ? draft.audience.sources.filter((s) => s !== source)
          : [...draft.audience.sources, source],
      },
    });
  };
  return (
    <Card title="Audience">
      <div className="space-y-5">
        <p className="text-ui text-text-secondary">
          Choose who might get this email. Only people who agreed to{' '}
          <strong>{PURPOSE_WORDS[draft.purpose].label.toLowerCase()}</strong> from you will get it.
          Buying a ticket is not the same as agreeing.
        </p>
        <fieldset className="grid gap-3 sm:grid-cols-2">
          <legend className="sr-only">Groups of people</legend>
          {(Object.keys(SOURCE_WORDS) as (keyof typeof SOURCE_WORDS)[]).map((s) => (
            <label key={s} className="flex items-start gap-3 rounded-lg border border-border p-3">
              <input
                type="checkbox"
                className="mt-1"
                checked={draft.audience.sources.includes(s)}
                onChange={() => toggle(s)}
              />
              <span>
                <span className="block font-medium text-text-primary">{SOURCE_WORDS[s].label}</span>
                <span className="block text-caption text-text-secondary">
                  {SOURCE_WORDS[s].hint}
                </span>
              </span>
            </label>
          ))}
        </fieldset>
        {draft.audience.sources.includes('EVENT_BUYERS') && (
          <fieldset>
            <legend className="text-ui font-medium text-text-primary">Events</legend>
            <div className="mt-2 grid gap-2 sm:grid-cols-2">
              {events.map((e) => {
                const on = draft.audience.eventIds?.includes(e.id) ?? false;
                return (
                  <label key={e.id} className="flex items-center gap-2 text-ui">
                    <input
                      type="checkbox"
                      checked={on}
                      onChange={() =>
                        set({
                          audience: {
                            ...draft.audience,
                            eventIds: on
                              ? (draft.audience.eventIds ?? []).filter((x) => x !== e.id)
                              : [...(draft.audience.eventIds ?? []), e.id],
                          },
                        })
                      }
                    />
                    {e.title}
                  </label>
                );
              })}
            </div>
          </fieldset>
        )}
        {status.entitlements.audienceAdvanced ? (
          <div className="grid gap-4 sm:grid-cols-2">
            <Input
              label="Cities (optional)"
              hint="Only people who booked with you in these cities. Separate with commas."
              value={citiesText}
              onChange={(e) => {
                setCitiesText(e.target.value);
                const cities = e.target.value
                  .split(',')
                  .map((c) => c.trim())
                  .filter(Boolean);
                set({
                  audience: { ...draft.audience, cities: cities.length ? cities : undefined },
                });
              }}
            />
            <Select
              label="Saved audience (optional)"
              value={draft.audience.savedSegmentId ?? ''}
              onChange={(e) =>
                set({
                  audience: { ...draft.audience, savedSegmentId: e.target.value || undefined },
                })
              }
            >
              <option value="">None</option>
              {(segments.data ?? []).map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                </option>
              ))}
            </Select>
          </div>
        ) : (
          <p className="text-caption text-text-muted">
            City filters and saved audiences are part of the Premium plan.
          </p>
        )}
        <div aria-live="polite">
          {!ok ? null : counts.isLoading ? (
            <Skeleton className="h-28 w-full" />
          ) : counts.isError ? (
            <ErrorState message={errorMessage(counts.error)} onRetry={() => counts.refetch()} />
          ) : counts.data ? (
            <AudienceCounts counts={counts.data} />
          ) : null}
        </div>
      </div>
    </Card>
  );
}

function BlockEditor({
  block,
  onChange,
  events,
}: {
  block: CampaignBlock;
  onChange: (b: CampaignBlock) => void;
  events: EventRow[];
}) {
  switch (block.type) {
    case 'heading':
      return (
        <Input
          label="Heading"
          value={block.text}
          maxLength={150}
          onChange={(e) => onChange({ ...block, text: e.target.value })}
        />
      );
    case 'paragraph':
      return (
        <Textarea
          label="Text"
          value={block.text}
          maxLength={2000}
          rows={4}
          onChange={(e) => onChange({ ...block, text: e.target.value })}
        />
      );
    case 'button':
      return (
        <div className="grid gap-3 sm:grid-cols-2">
          <Input
            label="Button words"
            value={block.label}
            maxLength={60}
            onChange={(e) => onChange({ ...block, label: e.target.value })}
          />
          <Input
            label="Link"
            hint="Your ETicketsGo pages only."
            value={block.url}
            onChange={(e) => onChange({ ...block, url: e.target.value })}
          />
        </div>
      );
    case 'offer':
      return (
        <div className="grid gap-3 sm:grid-cols-2">
          <Input
            label="Offer text"
            value={block.text}
            maxLength={300}
            onChange={(e) => onChange({ ...block, text: e.target.value })}
          />
          <Input
            label="Promo code"
            value={block.code ?? ''}
            maxLength={40}
            onChange={(e) => onChange({ ...block, code: e.target.value || undefined })}
          />
        </div>
      );
    case 'image':
      return (
        <div className="grid gap-3 sm:grid-cols-2">
          <Select
            label="Picture"
            value={block.source}
            onChange={(e) =>
              onChange({ ...block, source: e.target.value as 'EVENT' | 'ORGANIZER_LOGO' })
            }
          >
            <option value="EVENT">The event poster</option>
            <option value="ORGANIZER_LOGO">Your logo</option>
          </Select>
          <Input
            label="Describe the picture"
            value={block.alt}
            maxLength={150}
            onChange={(e) => onChange({ ...block, alt: e.target.value })}
          />
        </div>
      );
    case 'event':
      return (
        <Select
          label="Event card"
          value={block.eventId}
          onChange={(e) => onChange({ ...block, eventId: e.target.value })}
        >
          {events.map((e) => (
            <option key={e.id} value={e.id}>
              {e.title}
            </option>
          ))}
        </Select>
      );
    case 'divider':
      return <p className="text-caption text-text-muted">A line between parts of the email.</p>;
    default:
      return null;
  }
}

const BLOCK_LABELS: Record<CampaignBlock['type'], string> = {
  heading: 'Heading',
  paragraph: 'Text',
  image: 'Picture',
  button: 'Button',
  event: 'Event card',
  offer: 'Offer',
  divider: 'Line',
};

function DesignStep({
  orgId,
  campaignId,
  draft,
  set,
  events,
  version,
  onSave,
}: {
  orgId: string;
  campaignId: string;
  draft: Draft;
  set: (p: Partial<Draft>) => void;
  events: EventRow[];
  version: number | null;
  onSave: () => Promise<void>;
}) {
  const toast = useToast();
  const [view, setView] = useState<'desktop' | 'mobile'>('desktop');
  const [testTo, setTestTo] = useState('');
  const [testing, setTesting] = useState(false);
  const preview = useQuery({
    queryKey: ['campaign-preview', orgId, campaignId, version],
    queryFn: () => api.campaigns.preview(orgId, campaignId),
  });
  const move = (i: number, d: -1 | 1) => {
    const next = draft.blocks.slice();
    const j = i + d;
    if (j < 0 || j >= next.length) return;
    [next[i], next[j]] = [next[j], next[i]];
    set({ blocks: next });
  };
  return (
    <div className="grid gap-6 xl:grid-cols-2">
      <Card title="Design">
        <div className="space-y-4">
          {draft.blocks.map((b, i) => (
            <div key={i} className="rounded-lg border border-border p-3">
              <div className="mb-2 flex items-center justify-between">
                <span className="text-caption font-medium text-text-secondary">
                  {BLOCK_LABELS[b.type]}
                </span>
                <span className="flex gap-1">
                  <Button
                    variant="ghost"
                    size="sm"
                    aria-label="Move up"
                    onClick={() => move(i, -1)}
                    disabled={i === 0}
                  >
                    <ArrowUp className="h-4 w-4" aria-hidden />
                  </Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    aria-label="Move down"
                    onClick={() => move(i, 1)}
                    disabled={i === draft.blocks.length - 1}
                  >
                    <ArrowDown className="h-4 w-4" aria-hidden />
                  </Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    aria-label="Remove block"
                    onClick={() => set({ blocks: draft.blocks.filter((_, k) => k !== i) })}
                  >
                    <Trash2 className="h-4 w-4" aria-hidden />
                  </Button>
                </span>
              </div>
              <BlockEditor
                block={b}
                events={events}
                onChange={(nb) => set({ blocks: draft.blocks.map((x, k) => (k === i ? nb : x)) })}
              />
            </div>
          ))}
          <div className="flex flex-wrap gap-2">
            {(Object.keys(BLOCK_LABELS) as CampaignBlock['type'][]).map((t) => {
              const nb = newBlock(t, draft.eventId || events[0]?.id);
              return (
                <Button
                  key={t}
                  variant="outline"
                  size="sm"
                  disabled={!nb || draft.blocks.length >= 30}
                  onClick={() => nb && set({ blocks: [...draft.blocks, nb] })}
                >
                  Add {BLOCK_LABELS[t].toLowerCase()}
                </Button>
              );
            })}
          </div>
          <Button variant="secondary" onClick={() => void onSave()}>
            Save and refresh the preview
          </Button>
        </div>
      </Card>
      <Card
        title="Preview"
        action={
          <span className="flex gap-1" role="group" aria-label="Preview size">
            <Button
              variant={view === 'desktop' ? 'tinted' : 'ghost'}
              size="sm"
              aria-pressed={view === 'desktop'}
              onClick={() => setView('desktop')}
            >
              <Monitor className="h-4 w-4" aria-hidden /> Desktop
            </Button>
            <Button
              variant={view === 'mobile' ? 'tinted' : 'ghost'}
              size="sm"
              aria-pressed={view === 'mobile'}
              onClick={() => setView('mobile')}
            >
              <Smartphone className="h-4 w-4" aria-hidden /> Mobile
            </Button>
          </span>
        }
      >
        {preview.isLoading ? (
          <Skeleton className="h-96 w-full" />
        ) : preview.isError ? (
          <ErrorState message={errorMessage(preview.error)} onRetry={() => preview.refetch()} />
        ) : (
          <div className="flex justify-center overflow-x-auto">
            {/* sandbox with no permissions: nothing in the email can run or navigate the console. */}
            <iframe
              title="Email preview"
              sandbox=""
              srcDoc={preview.data?.html}
              className="h-[640px] rounded-md border border-border bg-background-surface"
              style={{ width: view === 'desktop' ? 640 : 375 }}
            />
          </div>
        )}
        <div className="mt-4 flex flex-wrap items-end gap-2">
          <div className="min-w-[14rem] flex-1">
            <Input
              label="Send a test"
              hint="To your own or a team member's verified email address."
              type="email"
              value={testTo}
              onChange={(e) => setTestTo(e.target.value)}
            />
          </div>
          <Button
            variant="outline"
            loading={testing}
            disabled={!testTo.trim()}
            onClick={async () => {
              setTesting(true);
              try {
                const r = await api.campaigns.testSend(orgId, campaignId, [testTo.trim()]);
                if (r.sent) toast.push('Test email sent.', 'success');
                else toast.push('The test email was not accepted.', 'error');
              } catch (err) {
                toast.push(errorMessage(err), 'error');
              } finally {
                setTesting(false);
              }
            }}
          >
            Send test
          </Button>
        </div>
      </Card>
    </div>
  );
}

function ScheduleStep({ draft, set }: { draft: Draft; set: (p: Partial<Draft>) => void }) {
  const zones = useMemo(
    () => [...new Set([browserZone(), draft.timezone, ...COMMON_TIME_ZONES])],
    [draft.timezone],
  );
  return (
    <Card title="Schedule">
      <div className="space-y-5">
        <Select
          label="Time zone of your audience"
          hint="The schedule and the quiet hours are read in this time zone."
          value={draft.timezone}
          onChange={(e) => set({ timezone: e.target.value })}
        >
          {zones.map((z) => (
            <option key={z} value={z}>
              {z}
            </option>
          ))}
        </Select>
        <label className="flex items-center gap-2 text-ui">
          <input
            type="checkbox"
            checked={draft.quietOn}
            onChange={(e) => set({ quietOn: e.target.checked })}
          />
          Do not send during quiet hours
        </label>
        {draft.quietOn && (
          <div className="grid gap-4 sm:grid-cols-2">
            <Input
              label="Quiet from"
              type="time"
              value={draft.quiet.start}
              onChange={(e) => set({ quiet: { ...draft.quiet, start: e.target.value } })}
            />
            <Input
              label="Quiet until"
              type="time"
              value={draft.quiet.end}
              onChange={(e) => set({ quiet: { ...draft.quiet, end: e.target.value } })}
            />
          </div>
        )}
        <p className="text-caption text-text-muted">
          You choose to send now or at a set time on the next step, after the final checks.
        </p>
      </div>
    </Card>
  );
}

function ReviewStep({
  orgId,
  campaignId,
  draft,
  canSchedule,
  onDone,
}: {
  orgId: string;
  campaignId: string;
  draft: Draft;
  canSchedule: boolean;
  onDone: (id: string) => void;
}) {
  const toast = useToast();
  const [mode, setMode] = useState<'now' | 'later'>('now');
  const [when, setWhen] = useState('');
  const [confirmed, setConfirmed] = useState(false);
  const [busy, setBusy] = useState(false);
  const review = useQuery({
    queryKey: ['campaign-review', orgId, campaignId],
    queryFn: () => api.campaigns.review(orgId, campaignId),
  });
  if (review.isLoading) return <Skeleton className="h-64 w-full" />;
  if (review.isError || !review.data) {
    return <ErrorState message={errorMessage(review.error)} onRetry={() => review.refetch()} />;
  }
  const r = review.data;
  const eligible = r.audience?.eligible ?? 0;
  const scheduledIso = mode === 'later' ? zonedLocalToIso(when, draft.timezone) : null;
  const blocked = r.problems.length > 0 || !r.confirmationToken;
  return (
    <Card title="Review">
      <div className="space-y-5">
        <dl className="grid gap-3 text-ui sm:grid-cols-2">
          <div>
            <dt className="text-text-secondary">Subject</dt>
            <dd className="font-medium text-text-primary">{r.campaign.subject}</dd>
          </div>
          <div>
            <dt className="text-text-secondary">From</dt>
            <dd className="font-medium text-text-primary">
              {r.campaign.senderName} via ETicketsGo
            </dd>
          </div>
          <div>
            <dt className="text-text-secondary">Kind of email</dt>
            <dd className="font-medium text-text-primary">
              {PURPOSE_WORDS[r.campaign.purpose].label}
            </dd>
          </div>
          <div>
            <dt className="text-text-secondary">Quiet hours</dt>
            <dd className="font-medium text-text-primary">
              {r.campaign.quietHours
                ? `${r.campaign.quietHours.start} to ${r.campaign.quietHours.end} (${r.campaign.timezone})`
                : 'None'}
            </dd>
          </div>
        </dl>
        {r.audience && <AudienceCounts counts={r.audience} />}
        <SendingModeNote mode={r.sendingMode} />
        <Problems items={r.problems} />
        {!blocked && (
          <>
            <fieldset className="space-y-2">
              <legend className="text-ui font-medium text-text-primary">When</legend>
              <label className="flex items-center gap-2 text-ui">
                <input
                  type="radio"
                  name="when"
                  checked={mode === 'now'}
                  onChange={() => setMode('now')}
                />
                Send now
                {r.quietHoursNow && (
                  <span className="text-status-warning">
                    {' '}
                    (it is quiet hours now; you can send from {dateTime(r.nextSendableAt)})
                  </span>
                )}
              </label>
              <label className="flex items-center gap-2 text-ui">
                <input
                  type="radio"
                  name="when"
                  disabled={!canSchedule}
                  checked={mode === 'later'}
                  onChange={() => setMode('later')}
                />
                Schedule for later
                {!canSchedule && (
                  <span className="text-text-muted"> (part of the Pro and Premium plans)</span>
                )}
              </label>
              {mode === 'later' && (
                <Input
                  label={`Date and time (${draft.timezone})`}
                  type="datetime-local"
                  value={when}
                  onChange={(e) => setWhen(e.target.value)}
                />
              )}
            </fieldset>
            <label className="flex items-start gap-2 text-ui">
              <input
                type="checkbox"
                className="mt-1"
                checked={confirmed}
                onChange={(e) => setConfirmed(e.target.checked)}
              />
              <span>
                I confirm this email goes to {eligible.toLocaleString()}{' '}
                {eligible === 1 ? 'person' : 'people'} who agreed to hear from us, and that it is
                accurate.
              </span>
            </label>
            <Button
              loading={busy}
              disabled={
                !confirmed ||
                (mode === 'later' && !scheduledIso) ||
                (mode === 'now' && r.quietHoursNow)
              }
              onClick={async () => {
                setBusy(true);
                try {
                  const v = r.campaign.version;
                  const token = r.confirmationToken!;
                  if (mode === 'now') {
                    await api.campaigns.send(orgId, campaignId, {
                      version: v,
                      confirmationToken: token,
                    });
                    toast.push('Sending has started.', 'success');
                  } else {
                    await api.campaigns.schedule(orgId, campaignId, {
                      version: v,
                      confirmationToken: token,
                      scheduledAt: scheduledIso!,
                    });
                    toast.push('Campaign scheduled.', 'success');
                  }
                  onDone(campaignId);
                } catch (err) {
                  toast.push(errorMessage(err), 'error');
                  void review.refetch();
                } finally {
                  setBusy(false);
                }
              }}
            >
              {mode === 'now' ? `Send to ${eligible.toLocaleString()} now` : 'Schedule campaign'}
            </Button>
          </>
        )}
      </div>
    </Card>
  );
}
