'use client';

import { useState } from 'react';
import { Check, Copy } from 'lucide-react';
import { useTranslations } from 'next-intl';

/**
 * A booking reference or receipt number, shown the same way everywhere and copyable.
 *
 * ── WHY THE FORMAT ITSELF IS NOT CHANGING ──────────────────────────────────────────
 * `ETG-IND-2026-000003` and `RCT-2026-000003` are issued financial identifiers. They are on
 * receipts in customers' hands, in support threads and in accounting exports, and a new shape
 * only ever applies to what is issued NEXT — so changing it buys a tidier future at the price
 * of two formats live at once, forever, with no way to tell from the string which era it is
 * from. The formats are fine. What was poor was reading them.
 *
 * ── WHAT ACTUALLY MAKES THEM USABLE ────────────────────────────────────────────────
 * Monospace, so the digit groups line up and a transposed character is visible. One tap to
 * copy, because the thing people do with a reference is paste it somewhere — into a support
 * form, a search box, an email — and selecting a twenty-character string by hand on a phone
 * is where the transcription errors come from.
 *
 * `select-all` on the text itself covers the case where the clipboard API is unavailable,
 * which happens on insecure origins and in some embedded browsers. The copy button hides
 * itself there rather than sitting inert.
 */
export function ReferenceCode({
  value,
  label,
  className = '',
}: {
  value: string;
  /** What this identifies, for screen readers: "Booking reference", "Receipt number". */
  label: string;
  className?: string;
}) {
  const t = useTranslations('storefront.common');
  const [copied, setCopied] = useState(false);
  const canCopy = typeof navigator !== 'undefined' && Boolean(navigator.clipboard);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      // Long enough to read, short enough that the button is ready again before they need it.
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // A clipboard that refuses is not an error worth interrupting anybody over; the text
      // is selectable, which is the fallback this silence relies on.
    }
  };

  return (
    <span className={`inline-flex items-center gap-1.5 ${className}`}>
      <span className="select-all font-mono tracking-tight text-text-primary" aria-label={label}>
        {value}
      </span>
      {canCopy && (
        <button
          type="button"
          onClick={copy}
          aria-label={`${label}: ${copied ? t('copied') : t('copy')}`}
          className="rounded p-0.5 text-text-muted transition-colors hover:text-text-primary focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-primary"
        >
          {copied ? (
            <Check className="h-3.5 w-3.5 text-status-success" aria-hidden />
          ) : (
            <Copy className="h-3.5 w-3.5" aria-hidden />
          )}
        </button>
      )}
      {/* Announced rather than only shown, so the confirmation reaches a screen reader too. */}
      <span role="status" aria-live="polite" className="sr-only">
        {copied ? t('copied') : ''}
      </span>
    </span>
  );
}
