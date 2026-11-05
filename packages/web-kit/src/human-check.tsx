'use client';

import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { Button, Dialog } from './components';
import { setHumanCheckHandler, type HumanCheckChallenge } from './api';

/**
 * Cloudflare Turnstile in the browser: the widget, and the one dialog that shows it when the
 * API asks for a human check.
 *
 * ── WHEN SOMEBODY SEES THIS ────────────────────────────────────────────────────────
 * Only after the API answered 428 HUMAN_CHECK_REQUIRED (or 403 HUMAN_CHECK_FAILED). With the
 * check off on the API - the default - this never opens, and the Cloudflare script is never
 * loaded: nothing is fetched from a third party on page load.
 *
 * ── WHY "MANAGED" AND interaction-only ─────────────────────────────────────────────
 * Most visitors pass without doing anything. `appearance: 'interaction-only'` keeps the widget
 * hidden unless Cloudflare needs a click, so the usual experience is a dialog that says
 * "Checking" for a second or two and closes itself. When a click IS needed, the widget is a
 * real checkbox Cloudflare has built for keyboard and screen-reader use; our own words around
 * it are plain text in the dialog, read out with its title.
 *
 * ── WHEN IT CANNOT LOAD ────────────────────────────────────────────────────────────
 * A content blocker, a captive portal or a bad connection can stop the script. The person is
 * then told so in words, with a "Try again" button, and Cancel returns the original refusal to
 * the form that sent the request - never a silent spinner.
 */

export const TURNSTILE_SCRIPT_URL =
  'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit';

/** How long the script may take to arrive before the person is told it did not. */
const SCRIPT_TIMEOUT_MS = 10_000;

interface TurnstileRenderOptions {
  sitekey: string;
  action?: string;
  appearance?: 'always' | 'execute' | 'interaction-only';
  theme?: 'auto' | 'light' | 'dark';
  language?: string;
  size?: 'normal' | 'flexible' | 'compact';
  callback?: (token: string) => void;
  'error-callback'?: (code: string) => boolean | void;
  'expired-callback'?: () => void;
  'timeout-callback'?: () => void;
}

interface TurnstileApi {
  render(container: HTMLElement, options: TurnstileRenderOptions): string | undefined;
  remove(widgetId: string): void;
  reset(widgetId: string): void;
}

declare global {
  interface Window {
    turnstile?: TurnstileApi;
  }
}

let scriptLoad: Promise<TurnstileApi> | null = null;

/** Load the Cloudflare script once. A failed load is forgotten, so "Try again" really retries. */
export function loadTurnstile(): Promise<TurnstileApi> {
  if (typeof window === 'undefined') return Promise.reject(new Error('No browser.'));
  if (window.turnstile) return Promise.resolve(window.turnstile);
  if (scriptLoad) return scriptLoad;
  scriptLoad = new Promise<TurnstileApi>((resolve, reject) => {
    const script = document.createElement('script');
    script.src = TURNSTILE_SCRIPT_URL;
    script.async = true;
    const fail = () => {
      window.clearTimeout(timer);
      script.remove();
      scriptLoad = null;
      reject(new Error('Turnstile did not load.'));
    };
    const timer = window.setTimeout(fail, SCRIPT_TIMEOUT_MS);
    script.onload = () => {
      window.clearTimeout(timer);
      if (window.turnstile) resolve(window.turnstile);
      else fail();
    };
    script.onerror = fail;
    document.head.appendChild(script);
  });
  return scriptLoad;
}

export interface HumanCheckLabels {
  title: string;
  description: string;
  checking: string;
  failed: string;
  retry: string;
  cancel: string;
}

/** English defaults. The storefront passes its own from the shared catalogue (en and fr-CA). */
export const HUMAN_CHECK_LABELS: HumanCheckLabels = {
  title: 'Confirm you are a person',
  description:
    'We ask this to stop automated sign-ups and messages. It usually takes a few seconds.',
  checking: 'Checking. This takes a few seconds.',
  failed:
    'The check did not load. Check your connection, or turn off a content blocker for this site. Then try again.',
  retry: 'Try again',
  cancel: 'Cancel',
};

/**
 * One Turnstile widget. Calls `onToken` once with a solved token, `onError` when the script or
 * the challenge fails. Removed from the page when it unmounts, so a stale widget never answers.
 */
export function TurnstileWidget({
  siteKey,
  action,
  language,
  onToken,
  onError,
}: {
  siteKey: string;
  action: string;
  language?: string;
  onToken: (token: string) => void;
  onError: () => void;
}) {
  const container = useRef<HTMLDivElement>(null);
  // Held in refs so a parent re-render does not tear the widget down and start again.
  const handlers = useRef({ onToken, onError });
  handlers.current = { onToken, onError };

  useEffect(() => {
    let widgetId: string | undefined;
    let cancelled = false;
    loadTurnstile()
      .then((turnstile) => {
        if (cancelled || !container.current) return;
        widgetId = turnstile.render(container.current, {
          sitekey: siteKey,
          action,
          appearance: 'interaction-only',
          theme: 'auto',
          size: 'flexible',
          language: language ?? 'auto',
          callback: (token) => handlers.current.onToken(token),
          'error-callback': () => {
            handlers.current.onError();
            // Handled here: stops Cloudflare's own retry loop and its console noise.
            return true;
          },
          'expired-callback': () => handlers.current.onError(),
          'timeout-callback': () => handlers.current.onError(),
        });
      })
      .catch(() => {
        if (!cancelled) handlers.current.onError();
      });
    return () => {
      cancelled = true;
      if (widgetId && window.turnstile) {
        try {
          window.turnstile.remove(widgetId);
        } catch {
          // Already gone with its container.
        }
      }
    };
  }, [siteKey, action, language]);

  return <div ref={container} data-human-check-widget="" />;
}

/**
 * Registers the shared client's human-check handler and draws the dialog it opens.
 *
 * Mounted once per app (inside `WebProviders`). A request refused with HUMAN_CHECK_REQUIRED
 * waits on the promise this hands back: a token repeats the request, null (Cancel, or no site
 * key) lets the original refusal reach the form, which shows its message as for any error.
 */
export function HumanCheckProvider({
  children,
  labels = HUMAN_CHECK_LABELS,
  language,
}: {
  children: ReactNode;
  labels?: HumanCheckLabels;
  /** Turnstile's own language (e.g. `fr`). Unset: the browser's. */
  language?: string;
}) {
  const [challenge, setChallenge] = useState<HumanCheckChallenge | null>(null);
  const [failed, setFailed] = useState(false);
  // Bumped by "Try again" to mount a fresh widget (and a fresh script load if that failed).
  const [attempt, setAttempt] = useState(0);
  const settle = useRef<((token: string | null) => void) | null>(null);

  const ask = useCallback(
    (next: HumanCheckChallenge) =>
      new Promise<string | null>((resolve) => {
        // No key, no widget: let the refusal through rather than open a dialog that cannot work.
        if (!next.siteKey) {
          resolve(null);
          return;
        }
        settle.current?.(null);
        settle.current = resolve;
        setFailed(false);
        setChallenge(next);
      }),
    [],
  );

  useEffect(() => {
    setHumanCheckHandler(ask);
    return () => setHumanCheckHandler(null);
  }, [ask]);

  const finish = useCallback((token: string | null) => {
    setChallenge(null);
    settle.current?.(token);
    settle.current = null;
  }, []);

  const onError = useCallback(() => setFailed(true), []);

  return (
    <>
      {children}
      <Dialog
        open={challenge !== null}
        onClose={() => finish(null)}
        title={labels.title}
        description={labels.description}
      >
        <div className="space-y-4">
          <p role="status" aria-live="polite" className="text-body text-text-muted">
            {failed ? '' : labels.checking}
          </p>
          {failed ? (
            <p role="alert" className="text-body text-status-error">
              {labels.failed}
            </p>
          ) : (
            challenge?.siteKey && (
              <TurnstileWidget
                key={attempt}
                siteKey={challenge.siteKey}
                action={challenge.action}
                language={language}
                onToken={(token) => finish(token)}
                onError={onError}
              />
            )
          )}
          <div className="flex justify-end gap-2">
            <Button type="button" variant="outline" onClick={() => finish(null)}>
              {labels.cancel}
            </Button>
            {failed && (
              <Button
                type="button"
                onClick={() => {
                  setFailed(false);
                  setAttempt((n) => n + 1);
                }}
              >
                {labels.retry}
              </Button>
            )}
          </div>
        </div>
      </Dialog>
    </>
  );
}
