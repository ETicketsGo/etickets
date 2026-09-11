import { describe, expect, it } from 'vitest';
import {
  PASSWORD_MAX_LENGTH,
  PASSWORD_MIN_LENGTH,
  isReservedEmail,
  passwordProblems,
  passwordStrength,
  phoneOnlyEmail,
  type PasswordContext,
} from '@eticketsgo/shared-types';
import { inviteMemberSchema, passwordSchema, registerSchema } from './index';

/**
 * The password policy, and the schemas that apply it.
 *
 * ── WHAT WAS THERE BEFORE ──────────────────────────────────────────────────────────
 * Eight characters, and nothing else. `Password123!` — the seed password, and one of the first
 * guesses in every cracking list — passed, as did `12345678` and a person's own name.
 *
 * ── WHY SO MANY OF THESE ARE ABOUT WHAT IS ALLOWED ─────────────────────────────────
 * A policy that refuses too much is not stricter, it is ignored: people copy the password
 * into a note, or give up at the sign-up form. The tests that assert a reasonable password is
 * ACCEPTED matter as much as the ones that assert a bad one is refused.
 */

const codes = (password: string, context?: PasswordContext) =>
  passwordProblems(password, context).map((p) => p.code);

describe('length', () => {
  it('refuses a password shorter than the minimum', () => {
    expect(codes('Kx7!mQ2#p')).toContain('TOO_SHORT');
  });

  it('accepts a sound password of exactly the minimum length', () => {
    expect('Kx7!mQ2#pL').toHaveLength(PASSWORD_MIN_LENGTH);
    expect(codes('Kx7!mQ2#pL')).toEqual([]);
  });

  it('refuses beyond the maximum without pattern-matching the rest', () => {
    const long = Array.from({ length: PASSWORD_MAX_LENGTH + 1 }, (_, i) =>
      String.fromCharCode(97 + ((i * 7) % 26)),
    ).join('');
    expect(codes(long)).toEqual(['TOO_LONG']);
  });
});

describe('common passwords, however they are dressed up', () => {
  it.each([
    ['the seed password', 'Password123!'],
    ['letters swapped for digits and a year', 'P@ssw0rd2026'],
    ['symbols wrapped round it', '!!Qwerty!!'],
    ['a year on the end', 'iloveyou2024'],
    ['the same word twice', 'passwordpassword'],
    ['the name of this platform', 'eticketsgo2026'],
    ['the launch city', 'Hyderabad@123'],
  ])('refuses %s (%s)', (_label, password) => {
    expect(codes(password)).toContain('TOO_COMMON');
  });

  it('does not refuse a phrase merely because it contains a common word', () => {
    // Matched exactly, never as a substring. Refusing this would be refusing at random.
    expect(codes('my-password-manager-rocks')).toEqual([]);
  });
});

describe('predictable patterns', () => {
  it.each([
    ['a phone number', '9704464007'],
    ['one character repeated', 'aaaaaaaaaaaa'],
    ['two characters alternating', 'abababababab'],
    ['the alphabet', 'abcdefghijk'],
    ['a keyboard row', 'qwertyuiop'],
    ['the alphabet backwards', 'zyxwvutsrq'],
  ])('refuses %s (%s)', (_label, password) => {
    expect(codes(password)).toContain('TOO_PREDICTABLE');
  });
});

describe('the person’s own details', () => {
  const asha = { email: 'asha.menon@example.com', name: 'Asha Menon' };

  it('refuses their name', () => {
    expect(codes('Menon@Harbour47', asha)).toContain('CONTAINS_PERSONAL_INFO');
  });

  it('refuses their email address', () => {
    expect(codes('asha.menon.tickets', asha)).toContain('CONTAINS_PERSONAL_INFO');
  });

  it('refuses their name with letters swapped for digits', () => {
    expect(codes('M3n0n-Harbour-47', asha)).toContain('CONTAINS_PERSONAL_INFO');
  });

  it('ignores name parts too short to mean anything', () => {
    // "Jo" and "Li" occur inside plenty of unrelated passwords.
    expect(codes('Jo-Li-Harbour-4747', { name: 'Jo Li' })).toEqual([]);
  });

  it('cannot apply without knowing who the password belongs to', () => {
    expect(codes('Menon@Harbour47')).not.toContain('CONTAINS_PERSONAL_INFO');
  });
});

describe('strength', () => {
  it('scores a refused password zero', () => {
    expect(passwordStrength('Password123!').score).toBe(0);
  });

  it('never rates a password the policy refuses as acceptable', () => {
    // The meter and the server must not disagree, in either direction.
    for (const refused of ['Password123!', '9704464007', 'short', 'abababababab']) {
      expect(passwordProblems(refused).length).toBeGreaterThan(0);
      expect(passwordStrength(refused).score).toBe(0);
    }
  });

  it('rates length and variety upward', () => {
    expect(passwordStrength('kxmqpltrzw').score).toBe(1);
    expect(passwordStrength('Kx7mQ2pLtr').score).toBe(2);
    expect(passwordStrength('Blue-Lantern-Harbour-47').score).toBe(3);
  });
});

describe('the registration schema', () => {
  const form = (over: Record<string, string> = {}) => ({
    email: 'Asha.Menon@Example.com',
    password: 'Blue-Lantern-Harbour-47',
    fullName: 'Asha Menon',
    ...over,
  });

  it('accepts a sound registration and lowercases the email', () => {
    const parsed = registerSchema.parse(form());
    expect(parsed.email).toBe('asha.menon@example.com');
  });

  it('refuses a common password, against the password field', () => {
    const result = registerSchema.safeParse(form({ password: 'Password123!' }));
    expect(result.success).toBe(false);
    expect(result.error?.issues.some((i) => i.path.join('.') === 'password')).toBe(true);
  });

  it('refuses a password made of the name typed beside it', () => {
    const result = registerSchema.safeParse(form({ password: 'Asha-Harbour-4747' }));
    expect(result.success).toBe(false);
    expect(result.error?.issues.map((i) => i.path.join('.'))).toContain('password');
  });

  it('refuses an address in the phone sign-in domain', () => {
    const result = registerSchema.safeParse(form({ email: phoneOnlyEmail('+919704464007') }));
    expect(result.success).toBe(false);
    expect(result.error?.issues.map((i) => i.path.join('.'))).toContain('email');
  });

  it('does the same for team invitations', () => {
    const result = inviteMemberSchema.safeParse({
      email: phoneOnlyEmail('+919704464007'),
      role: 'CHECKIN_STAFF',
    });
    expect(result.success).toBe(false);
  });

  it('reports length through the shared password schema', () => {
    expect(passwordSchema.safeParse('short').success).toBe(false);
  });
});

describe('the reserved domain', () => {
  it('recognises the placeholder shape existing phone-only accounts already use', () => {
    expect(phoneOnlyEmail('+919704464007')).toBe('phone+919704464007@users.eticketsgo.internal');
    expect(isReservedEmail('phone+919704464007@users.eticketsgo.internal')).toBe(true);
    expect(isReservedEmail('x@deep.users.eticketsgo.internal')).toBe(true);
  });

  it('leaves ordinary addresses alone', () => {
    expect(isReservedEmail('asha@gmail.com')).toBe(false);
    // A look-alike domain is not ours, and refusing it would be refusing a real customer.
    expect(isReservedEmail('asha@users-eticketsgo.internal.example.com')).toBe(false);
  });
});
