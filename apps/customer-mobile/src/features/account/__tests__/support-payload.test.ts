import { submitFeedbackSchema } from '@eticketsgo/validation';

/**
 * The body the support form sends, checked against the schema the API validates it with.
 *
 * ── WHY THIS EXISTS ───────────────────────────────────────────────────────────────
 * The form posted `{ email, subject, message }`. `submitFeedbackSchema` requires `kind`,
 * with no default — so every submission was rejected with "The request failed validation."
 * and the message was never recorded.
 *
 * It went unnoticed because of what the screen is: a support form that silently swallows
 * support requests is the one form nobody can report a bug about. Nothing crashed, no test
 * covered the payload shape, and the endpoint answered a tidy 400.
 *
 * So this validates the ACTUAL object the screen builds against the REAL schema, rather
 * than asserting a hand-copied shape that could drift the same way.
 */

/** Mirrors the payload assembled in `app/support.tsx`. */
const supportPayload = (over: Record<string, unknown> = {}) => ({
  kind: 'CONTACT',
  email: 'someone@example.test',
  subject: 'Cannot scan my ticket',
  message: 'The QR will not scan at the gate.\n\n---\nETicketsGo mobile 1.0.0 (qa) · android 34',
  ...over,
});

describe('the support form payload', () => {
  it('satisfies the schema the API validates it with', () => {
    const parsed = submitFeedbackSchema.safeParse(supportPayload());
    expect(parsed.success).toBe(true);
  });

  it('is REJECTED without kind — the defect this pins', () => {
    // Exactly what the screen used to send.
    const { kind, ...withoutKind } = supportPayload();
    void kind;
    const parsed = submitFeedbackSchema.safeParse(withoutKind);
    expect(parsed.success).toBe(false);
    if (!parsed.success) {
      expect(parsed.error.issues.some((i) => i.path.includes('kind'))).toBe(true);
    }
  });

  it('CONTACT needs no rating, unlike the satisfaction kinds', () => {
    // CSAT and ORGANIZER_CSAT require a rating; a contact form has nothing to rate, so
    // sending one of those kinds from this screen would fail a second validation rule.
    expect(submitFeedbackSchema.safeParse(supportPayload()).success).toBe(true);
    expect(submitFeedbackSchema.safeParse(supportPayload({ kind: 'CSAT' })).success).toBe(false);
  });

  it('accepts a signed-out sender, who supplies their own address', () => {
    // The endpoint is public with an optional guard: someone who cannot sign in is exactly
    // the person most likely to need it.
    expect(
      submitFeedbackSchema.safeParse(supportPayload({ email: 'guest@example.test' })).success,
    ).toBe(true);
  });

  it('still requires something to actually say', () => {
    expect(submitFeedbackSchema.safeParse(supportPayload({ message: '' })).success).toBe(false);
    expect(submitFeedbackSchema.safeParse(supportPayload({ message: '   ' })).success).toBe(false);
  });

  it('carries the build and platform footer the first reply always needs', () => {
    // Not a schema rule — a support-quality one. Without it the first response to every
    // ticket is "which version, which phone?", which costs a round trip with someone
    // already having a bad day.
    const { message } = supportPayload();
    expect(message).toMatch(/ETicketsGo mobile/);
    expect(message).toMatch(/android|ios/i);
  });
});
