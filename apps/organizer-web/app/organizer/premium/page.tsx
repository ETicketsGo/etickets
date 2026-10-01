'use client';

import { useState } from 'react';
import { CheckCircle2, Clock, Sparkles } from 'lucide-react';
import { ENTERPRISE_FEATURES, isFeatureEnabled } from '@eticketsgo/shared-types';
import {
  api,
  Badge,
  Button,
  Card,
  Dialog,
  PageHeader,
  Textarea,
  errorMessage,
  useToast,
} from '@eticketsgo/web-kit';
import { useOrg } from '@/components/org-context';

/**
 * What ETicketsGo can switch on for this organization, and how to ask.
 *
 * ── WHAT THIS REPLACES ─────────────────────────────────────────────────────────────
 * Nine cards, each with a padlock and a DISABLED button reading "Request access". Nine controls
 * that could not be pressed. In the organizer review I described it as a sales wall, which was
 * generous and wrong: a sales wall at least sells something. It was nine dead buttons in the
 * middle of an operational tool, with no prices, no availability anybody could act on, and no way
 * to ask.
 *
 * ── WHY THERE IS ONE ASK AND NOT NINE ──────────────────────────────────────────────
 * Nine identical controls is not nine choices, it is one choice repeated - whichever a person
 * presses, the conversation is the same. So each capability says what it does and whether it is
 * on, and there is a single way to start that conversation, which carries whichever capability
 * prompted it.
 *
 * ── NO ENTITLEMENT MODEL WAS INVENTED ──────────────────────────────────────────────
 * `isFeatureEnabled` reads a build-time flag, so availability is currently the same for every
 * organization. That is a real limitation and it is stated here rather than dressed up: a card
 * says "Available" or "Coming soon", and neither pretends to be a per-account entitlement. No
 * table was added to make a disabled button clickable, and no price is shown, because none has
 * been decided.
 *
 * The request goes through the support channel that already exists and is already triaged -
 * `FeedbackKind.FEATURE` - rather than a new workflow built overnight for nine placeholder cards.
 */
export default function PremiumPage() {
  const { activeOrg, activeOrgSentenceName } = useOrg();
  const toast = useToast();
  const [asking, setAsking] = useState<string | null>(null);
  const [note, setNote] = useState('');
  const [sending, setSending] = useState(false);

  const send = async () => {
    if (!asking) return;
    setSending(true);
    try {
      await api.support.submit({
        kind: 'FEATURE',
        // Named so whoever reads it knows which organization asked and about what, without
        // having to go and look either up.
        message:
          `Premium interest: ${asking}\n` +
          `Organization: ${activeOrgSentenceName} (${activeOrg.id})\n\n` +
          (note.trim() || 'No additional details.'),
      });
      toast.push('Thanks — we will be in touch about this.', 'success');
      setAsking(null);
      setNote('');
    } catch (err) {
      toast.push(errorMessage(err), 'error');
    } finally {
      setSending(false);
    }
  };

  return (
    <div className="space-y-6">
      <PageHeader
        title="Premium & enterprise"
        description="Capabilities we can switch on for your account. Tell us what you need and we will talk it through — there is nothing to buy on this page."
      />

      <div className="grid gap-4 sm:grid-cols-2">
        {ENTERPRISE_FEATURES.map((f) => {
          const enabled = isFeatureEnabled(f.flag);
          return (
            <Card key={f.flag}>
              <div className="flex items-start justify-between gap-3">
                <span className="flex h-10 w-10 items-center justify-center rounded-full bg-tint-primary text-action-primary">
                  <Sparkles className="h-5 w-5" aria-hidden />
                </span>
                {/* An icon beside the word, so the state does not depend on the badge's colour. */}
                <Badge tone={enabled ? 'success' : 'neutral'}>
                  {enabled ? (
                    <CheckCircle2 className="h-3.5 w-3.5" aria-hidden />
                  ) : (
                    <Clock className="h-3.5 w-3.5" aria-hidden />
                  )}
                  {enabled ? 'Available' : 'Coming soon'}
                </Badge>
              </div>
              <p className="mt-4 font-semibold text-text-primary">{f.title}</p>
              <p className="mt-1 text-[0.9375rem] text-text-muted">{f.description}</p>
              {/*
                A real control, or none at all. The old page put a disabled button on every card,
                which reads as something broken rather than something unavailable.
              */}
              {!enabled && (
                <Button
                  variant="outline"
                  size="sm"
                  className="mt-4"
                  onClick={() => setAsking(f.title)}
                >
                  Ask about {f.title}
                </Button>
              )}
            </Card>
          );
        })}
      </div>

      <Dialog
        open={asking !== null}
        onClose={() => setAsking(null)}
        title={asking ? `Ask about ${asking}` : 'Contact ETicketsGo'}
        footer={
          <>
            <Button variant="outline" onClick={() => setAsking(null)} disabled={sending}>
              Cancel
            </Button>
            <Button loading={sending} onClick={() => void send()}>
              Send
            </Button>
          </>
        }
      >
        <p className="text-sm text-text-secondary">
          We will read this and come back to you about <strong>{activeOrgSentenceName}</strong>.
          Tell us what you are trying to do, and we can say whether this is the right thing for it.
        </p>
        {/*
          The shared Textarea, not a hand-rolled one.

          This was a raw <textarea> carrying its own classes, and one of them - `bg-background` -
          is not a token at all, so the box had no surface colour: invisible against an elevated
          dialog in one theme and wrong in the other. The others were merely inconsistent
          (`border-border` is for card edges; form controls use `border-border-input`, and the
          focus ring differed from every other field on the platform). Reusing the component
          settles all of it in one place and cannot drift again.
        */}
        <div className="mt-3">
          <Textarea
            rows={4}
            aria-label="What are you trying to do?"
            placeholder="What are you trying to do?"
            value={note}
            onChange={(e) => setNote(e.target.value)}
          />
        </div>
      </Dialog>
    </div>
  );
}
