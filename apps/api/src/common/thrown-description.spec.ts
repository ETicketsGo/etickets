import { __testing } from './all-exceptions.filter';

/**
 * A 500 has to say what went wrong.
 *
 * ── THE SIX CHARACTERS THAT COST TWO DIAGNOSES ─────────────────────────────────────
 * The filter logged `exception instanceof Error ? exception.stack : String(exception)`, and a
 * plain object stringifies to `[object Object]`. Payment SDKs throw plain objects - Razorpay
 * rejects with `{statusCode, error: {code, description}}` - so every gateway failure logged
 * nothing at all. A 500 on QA's payment endpoint and a crash-looping production API were both
 * diagnosed by other means because the log said `[object Object]` each time.
 */
describe('describing what was thrown', () => {
  const { describeThrown } = __testing;

  it('keeps an Error stack, which is what a reader wants first', () => {
    const err = new Error('boom');
    expect(describeThrown(err)).toBe(err.stack);
  });

  it('describes a plain object instead of [object Object]', () => {
    const thrown = {
      statusCode: 400,
      error: { code: 'BAD_REQUEST_ERROR', description: 'card declined' },
    };
    const out = describeThrown(thrown);
    expect(out).not.toBe('[object Object]');
    expect(out).toContain('BAD_REQUEST_ERROR');
    expect(out).toContain('card declined');
  });

  it('redacts anything that looks like a credential', () => {
    const out = describeThrown({
      message: 'failed',
      key_secret: 'rzp_secret_value',
      headers: { authorization: 'Basic abc123' },
      card: { number: '4100280000001007' },
    });
    expect(out).not.toContain('rzp_secret_value');
    expect(out).not.toContain('Basic abc123');
    expect(out).not.toContain('4100280000001007');
    // Still says what happened.
    expect(out).toContain('failed');
  });

  it('survives something that will not serialise', () => {
    const circular: Record<string, unknown> = { a: 1 };
    circular.self = circular;
    // Depth-capped rather than thrown; either way it must return a string, never crash the filter.
    expect(typeof describeThrown(circular)).toBe('string');
  });

  it('handles a thrown string or null', () => {
    expect(describeThrown('just a string')).toContain('just a string');
    expect(typeof describeThrown(null)).toBe('string');
  });
});
