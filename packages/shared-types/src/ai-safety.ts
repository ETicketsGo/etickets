/**
 * PII-safe input controls for the AI layer (v2.0 WS1/WS10). Pure + deterministic so
 * the same redaction runs on the server before any prompt leaves the process, and is
 * unit-testable. Never sends raw emails, phone numbers, long digit runs (card/id-like)
 * or booking references to a provider. This is defence-in-depth: callers should also
 * pass only aggregate metrics, never raw customer rows.
 */

export interface RedactionResult {
  text: string;
  /** Count of redactions by kind, for safety-event telemetry. */
  counts: { email: number; phone: number; longDigits: number; reference: number };
}

const EMAIL_RE = /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g;
// 8+ digit runs (allowing spaces/dashes) — catches cards, long ids, phone bodies.
const LONG_DIGITS_RE = /\b(?:\d[ -]?){8,}\d\b/g;
// Booking references like ETG-IN-2026-000123.
const REFERENCE_RE = /\bETG-[A-Z]{2,3}-\d{4}-\d{3,}\b/g;
// Phone-ish: optional +, 7-15 digits with separators (looser than long-digits).
const PHONE_RE = /\+?\d[\d ()-]{6,}\d/g;

/**
 * Redact PII from free text destined for an AI provider. Order matters: references
 * and emails first, then long digit sequences, then looser phone patterns.
 */
export function redactPii(input: string): RedactionResult {
  const counts = { email: 0, phone: 0, longDigits: 0, reference: 0 };
  let text = input ?? '';

  text = text.replace(REFERENCE_RE, () => {
    counts.reference += 1;
    return '[REF]';
  });
  text = text.replace(EMAIL_RE, () => {
    counts.email += 1;
    return '[EMAIL]';
  });
  text = text.replace(LONG_DIGITS_RE, () => {
    counts.longDigits += 1;
    return '[NUMBER]';
  });
  text = text.replace(PHONE_RE, (m) => {
    // Skip if it's just a short standalone integer already handled.
    if (m.replace(/\D/g, '').length < 7) return m;
    counts.phone += 1;
    return '[PHONE]';
  });

  return { text, counts };
}

/** True when the text still appears to contain PII after redaction (a safety assertion). */
export function containsPii(input: string): boolean {
  const r = redactPii(input);
  return r.counts.email + r.counts.phone + r.counts.longDigits + r.counts.reference > 0;
}

/**
 * Redact every string field of a shallow record (used to sanitise structured context
 * before it becomes prompt input). Non-string values pass through untouched.
 */
export function redactRecord(record: Record<string, unknown>): {
  record: Record<string, unknown>;
  redacted: boolean;
} {
  let redacted = false;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(record)) {
    if (typeof v === 'string') {
      const r = redactPii(v);
      if (r.text !== v) redacted = true;
      out[k] = r.text;
    } else {
      out[k] = v;
    }
  }
  return { record: out, redacted };
}
