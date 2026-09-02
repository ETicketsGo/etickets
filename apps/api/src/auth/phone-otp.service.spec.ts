import * as bcrypt from 'bcryptjs';
import { PhoneOtpService } from './phone-otp.service';
import { normalisePhone, maskPhone } from './phone';

/**
 * Signing in with a six-digit code.
 *
 * ── WHY THESE TESTS ARE ALMOST ALL ABOUT REFUSAL ───────────────────────────────────
 * The happy path is four lines. What makes an OTP safe or unsafe is everything it declines
 * to do: how many guesses it tolerates, what it says to somebody probing for accounts,
 * whether a code outlives its use, and whether the code is readable by anyone who reaches
 * the database. A six-digit secret has a million values, which is a large number to a person
 * and a small one to a script.
 */
function setup(
  over: {
    existingUser?: unknown;
    recentSends?: number;
    otpRow?: unknown;
    template?: string;
  } = {},
) {
  const created: Record<string, unknown>[] = [];
  const updates: Record<string, unknown>[] = [];
  const sent: { body: string; payload: Record<string, unknown> }[] = [];

  const prisma = {
    phoneOtp: {
      count: jest.fn().mockResolvedValue(over.recentSends ?? 0),
      updateMany: jest.fn().mockResolvedValue({ count: 0 }),
      create: jest.fn(async ({ data }: { data: Record<string, unknown> }) => {
        created.push(data);
        return { id: 'otp-1', ...data };
      }),
      findFirst: jest.fn().mockResolvedValue(over.otpRow ?? null),
      update: jest.fn(async (args: Record<string, unknown>) => {
        updates.push(args);
        return {};
      }),
    },
    user: {
      findUnique: jest.fn().mockResolvedValue(over.existingUser ?? null),
      update: jest.fn().mockResolvedValue({}),
      create: jest.fn(async ({ data }: { data: Record<string, unknown> }) => ({
        id: 'user-new',
        ...data,
      })),
    },
  };
  const sms = {
    deliver: jest.fn(async (msg: { body: string; payload: Record<string, unknown> }) => {
      sent.push(msg);
    }),
  };
  const config = {
    get: (key: string) => (key === 'APP_ENV' ? 'PRODUCTION' : (over.template ?? undefined)),
  };
  const service = new PhoneOtpService(prisma as never, sms as never, config as never);
  return { service, prisma, sms, sent, created, updates };
}

describe('normalisePhone', () => {
  /*
    One person, one row. Every spelling below is the same phone; stored as typed they are
    four accounts, none of which has the customer's tickets in it — and a `@unique` column
    enforces nothing, because the duplicates are not equal.
  */
  it('folds every way a person types one Indian number into one value', () => {
    for (const typed of [
      '9704464007',
      '+91 97044 64007',
      '09704464007',
      '0091-9704464007',
      '+919704464007',
      ' 97044-64007 ',
    ]) {
      expect(normalisePhone(typed)).toBe('+919704464007');
    }
  });

  it('takes an international number at its word rather than forcing India onto it', () => {
    // The default country applies ONLY to a bare national number. A caller who wrote a `+`
    // has already said where they are.
    expect(normalisePhone('+1 415 555 0132')).toBe('+14155550132');
    expect(normalisePhone('+44 20 7946 0958')).toBe('+442079460958');
  });

  it('refuses something that cannot be a phone number', () => {
    expect(() => normalisePhone('')).toThrow(/mobile number/i);
    expect(() => normalisePhone('12345')).toThrow(/mobile number/i);
    expect(() => normalisePhone('1'.repeat(20))).toThrow(/mobile number/i);
  });

  it('masks to the last four, for telling somebody where a code went', () => {
    expect(maskPhone('+919704464007')).toMatch(/4007$/);
    expect(maskPhone('+919704464007')).not.toContain('9704464');
  });
});

describe('PhoneOtpService.requestCode', () => {
  it('stores the code HASHED, never in the clear', async () => {
    /*
      The single most important property here. Six digits in a plaintext column turns one
      database read — a backup, a log drain, an over-broad query — into every live sign-in on
      the platform, and nobody can rotate a code they never knew existed.
    */
    const { service, created, sent } = setup();
    await service.requestCode('9704464007');

    const row = created[0];
    const codeInMessage = /(\d{6})/.exec(sent[0].body)![1];
    expect(row.codeHash).not.toContain(codeInMessage);
    expect(await bcrypt.compare(codeInMessage, row.codeHash as string)).toBe(true);
  });

  it('sends to the normalised number, so one person gets one code', async () => {
    const { service, sent } = setup();
    await service.requestCode('097044 64007');
    expect(sent[0].payload.phone).toBe('+919704464007');
  });

  it('kills any outstanding code when a new one is asked for', async () => {
    // Two live codes double an attacker's odds and help nobody who simply pressed the
    // button twice.
    const { service, prisma } = setup();
    await service.requestCode('9704464007');
    expect(prisma.phoneOtp.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ data: { consumedAt: expect.any(Date) } }),
    );
  });

  it('refuses to keep sending to one number, so nobody can be SMS-bombed', async () => {
    // The edge throttle counts requests from one CALLER. This counts messages to one
    // RECIPIENT, which is the unit that matters when the cost is somebody else's.
    const { service } = setup({ recentSends: 5 });
    await expect(service.requestCode('9704464007')).rejects.toThrow(/too many/i);
  });

  it('renders the body from a CONFIGURED template, so India can be made compliant', async () => {
    /*
      TRAI requires the text of every SMS to match a template registered on a DLT portal, and
      an operator drops anything that differs from the approved wording. A body hardcoded here
      would mean every compliance correction is a code change and a deploy.
    */
    const { service, sent } = setup({
      template: 'Your ETicketsGo code is {code}. Valid {minutes} min. Do not share.',
    });
    await service.requestCode('9704464007');
    expect(sent[0].body).toMatch(/^Your ETicketsGo code is \d{6}\. Valid 10 min\. Do not share\.$/);
  });

  it('falls back to a readable default when no template is configured', async () => {
    const { service, sent } = setup();
    await service.requestCode('9704464007');
    expect(sent[0].body).toMatch(/\d{6}/);
    expect(sent[0].body).toMatch(/never share/i);
  });

  it('never returns the code to the caller', async () => {
    const { service } = setup();
    const result = await service.requestCode('9704464007');
    expect(JSON.stringify(result)).not.toMatch(/\d{6}/);
  });

  it('does NOT write the code through the notification service', async () => {
    /*
      `NotificationService.send()` persists a Notification row carrying the payload, which
      would put a live credential in a queryable table and in anything that ships it onward.
      The constructor takes the SMS channel directly for exactly this reason, and this test
      is what stops somebody "tidying" it back.
    */
    const { service, sms } = setup();
    await service.requestCode('9704464007');
    expect(sms.deliver).toHaveBeenCalledTimes(1);
  });
});

describe('PhoneOtpService.verifyCode', () => {
  const liveOtp = async (code: string, over: Record<string, unknown> = {}) => ({
    id: 'otp-1',
    phone: '+919704464007',
    codeHash: await bcrypt.hash(code, 10),
    expiresAt: new Date(Date.now() + 60_000),
    consumedAt: null,
    attempts: 0,
    ...over,
  });

  it('signs an existing customer into THEIR account', async () => {
    const { service } = setup({
      otpRow: await liveOtp('123456'),
      existingUser: { id: 'user-1' },
    });
    const result = await service.verifyCode('9704464007', '123456');
    expect(result).toEqual({ id: 'user-1', isNewAccount: false });
  });

  it('creates a password-less account when the number is new', async () => {
    /*
      No password and no real email, because the person supplied neither. The placeholder
      hash is the same trick the invite flow uses: an account that cannot be signed into with
      a password at all, only with a code, until somebody sets one.
    */
    const { service, prisma } = setup({ otpRow: await liveOtp('123456') });
    const result = await service.verifyCode('9704464007', '123456');

    expect(result.isNewAccount).toBe(true);
    const created = prisma.user.create.mock.calls[0][0].data;
    expect(created.phone).toBe('+919704464007');
    expect(created.passwordHash).toMatch(/^phone-only\$/);
    expect(created.phoneVerifiedAt).toBeInstanceOf(Date);
  });

  it('spends the code, so it cannot be replayed', async () => {
    const { service, updates } = setup({
      otpRow: await liveOtp('123456'),
      existingUser: { id: 'user-1' },
    });
    await service.verifyCode('9704464007', '123456');
    expect(updates.some((u) => (u.data as Record<string, unknown>).consumedAt)).toBe(true);
  });

  it('counts a wrong guess against the code itself', async () => {
    // A request throttle counts requests; this counts wrong answers against ONE code, so it
    // dies after a handful however the guesses arrive — several IPs, several sessions.
    const { service, updates } = setup({ otpRow: await liveOtp('123456') });
    await expect(service.verifyCode('9704464007', '000000')).rejects.toThrow(/not valid/i);
    expect(updates[0].data).toEqual({ attempts: { increment: 1 } });
  });

  it('burns a code that has been guessed at too many times', async () => {
    const { service, updates } = setup({ otpRow: await liveOtp('123456', { attempts: 5 }) });
    await expect(service.verifyCode('9704464007', '123456')).rejects.toThrow(/not valid/i);
    // Even the RIGHT code no longer works, and the row is spent rather than left to be
    // ground down further.
    expect(updates.some((u) => (u.data as Record<string, unknown>).consumedAt)).toBe(true);
  });

  it('says the same thing for no code, a wrong code and an expired one', async () => {
    /*
      Distinguishing them tells an attacker whether a number has a code outstanding, which is
      a small leak alone and a useful signal in bulk. The person who genuinely mistyped is
      told to ask for a new code either way, which is the action in every case.
    */
    const none = setup({ otpRow: null });
    const wrong = setup({ otpRow: await liveOtp('123456') });

    const a = await none.service.verifyCode('9704464007', '111111').catch((e) => e.message);
    const b = await wrong.service.verifyCode('9704464007', '000000').catch((e) => e.message);
    expect(a).toBe(b);
  });

  it('never signs anyone in on an expired code', async () => {
    // The query itself excludes expired rows, so an expired code is indistinguishable from
    // no code at all — which is the same answer, deliberately.
    const { service, prisma } = setup({ otpRow: null });
    await expect(service.verifyCode('9704464007', '123456')).rejects.toThrow();
    expect(prisma.phoneOtp.findFirst.mock.calls[0][0].where.expiresAt).toEqual({
      gt: expect.any(Date),
    });
  });
});
