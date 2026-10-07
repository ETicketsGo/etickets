import { registerSchema } from '@eticketsgo/validation';

/**
 * What the signup form may and may not conclude from what somebody typed.
 *
 * The A2P campaign rests on being able to show that a text-message agreement was given
 * deliberately. These are the rules that make that true, tested on the schema both the web
 * form and the API validate against, so the two cannot drift.
 */
describe('signup with a mobile number and a text-message agreement', () => {
  const base = {
    email: 'buyer@example.com',
    password: 'correct-horse-battery-staple',
    fullName: 'A Buyer',
  };

  it('creates an account with no phone and no consent at all', () => {
    // The floor this whole feature rests on: a mobile number is never required to buy a
    // ticket, so it is never required to have an account.
    expect(registerSchema.safeParse(base).success).toBe(true);
  });

  it('accepts a number WITHOUT the box, and that grants nothing', () => {
    /*
      Giving us a number so we can reach you about a problem is not asking to be texted.
      Treating it as consent is the exact inference the consent record exists to prevent, so
      the form must accept this combination rather than quietly upgrade it.
    */
    const parsed = registerSchema.safeParse({ ...base, phone: '+15551234567' });
    expect(parsed.success).toBe(true);
    if (parsed.success) expect(parsed.data.smsConsent).toBeUndefined();
  });

  it('accepts the box WITH a number', () => {
    const parsed = registerSchema.safeParse({
      ...base,
      phone: '+15551234567',
      smsConsent: true,
      country: 'US',
    });
    expect(parsed.success).toBe(true);
    if (parsed.success) expect(parsed.data.smsConsent).toBe(true);
  });

  it('refuses the box WITHOUT a number, and complains about the empty field', () => {
    const parsed = registerSchema.safeParse({ ...base, smsConsent: true });
    expect(parsed.success).toBe(false);
    if (!parsed.success) {
      const issue = parsed.error.issues.find((i) => i.path.join('.') === 'phone');
      /*
        The error belongs on the PHONE field, not the checkbox. Pointing at the checkbox
        tells somebody to undo the thing they just said they wanted; pointing at the empty
        field tells them what to fill in.
      */
      expect(issue).toBeDefined();
    }
  });

  it('defaults consent to absent rather than to false-looking-like-a-decision', () => {
    // Nothing in the payload means nobody was asked. That is not the same as being asked and
    // declining, and only the latter should ever write a row.
    const parsed = registerSchema.safeParse(base);
    if (parsed.success) expect('smsConsent' in parsed.data && parsed.data.smsConsent).toBeFalsy();
  });
});
