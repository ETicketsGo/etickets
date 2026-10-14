import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { NotificationType } from '@eticketsgo/shared-types';
import {
  DLT_SMS_TEMPLATES,
  DLT_VARIABLE,
  DLT_VARIABLE_MAX_LENGTH,
  OTP_SMS_KIND,
  dltVariablesFromPayload,
  fitDltVariable,
  formatMinor,
  matchDltSms,
  renderDltSms,
} from './dlt-sms-templates';

/**
 * The India DLT SMS registry.
 *
 * ── WHAT THIS PINS ─────────────────────────────────────────────────────────────────
 * An operator drops any SMS whose fixed text differs from the registered template, so the
 * exact rendered string for every kind is written out below by hand. A change to the wording
 * fails here, which is the moment to register the new wording on the DLT portal -- not after
 * the carrier has started dropping it.
 *
 * And the docs page the owner pastes into the portal is checked against the same wording, so
 * the text that is registered and the text that is sent cannot drift apart.
 */

const DOC = readFileSync(
  join(__dirname, '../../../../../docs/notifications/INDIA-DLT-TEMPLATES.md'),
  'utf8',
);

describe('DLT SMS registry', () => {
  const all = Object.values(DLT_SMS_TEMPLATES);

  it('covers the sign-in code, booking confirmed, cancelled, refunded and show cancelled', () => {
    expect(Object.keys(DLT_SMS_TEMPLATES).sort()).toEqual(
      [
        OTP_SMS_KIND,
        NotificationType.BOOKING_CANCELLED,
        NotificationType.BOOKING_CONFIRMED,
        NotificationType.REFUND_COMPLETED,
        NotificationType.SHOW_CANCELLED,
      ].sort(),
    );
  });

  it.each(all.map((t) => [t.kind, t] as const))(
    '%s is registrable: ASCII, one name per {#var#}, fixed text around them',
    (_kind, t) => {
      expect(t.text).toMatch(/^[\x20-\x7E]+$/);
      expect(t.text.split(DLT_VARIABLE).length - 1).toBe(t.variables.length);
      expect(new Set(t.variables).size).toBe(t.variables.length);
      // DLT does not approve a template that is only variables.
      expect(t.text.split(DLT_VARIABLE).join('').trim().length).toBeGreaterThan(20);
      expect(t.text).toContain('ETicketsGo');
      // Service, never promotional: nothing here is marketing.
      expect(t.category).toBe('SERVICE_IMPLICIT');
      expect(t.msg91TemplateIdEnv).toMatch(/^MSG91_SMS_TEMPLATE_[A-Z_]+$/);
      expect(t.dltTemplateIdEnv).toMatch(/^DLT_TEMPLATE_ID_[A-Z_]+$/);
    },
  );

  it('uses a distinct pair of keys for every template', () => {
    const keys = all.flatMap((t) => [t.msg91TemplateIdEnv, t.dltTemplateIdEnv]);
    expect(new Set(keys).size).toBe(keys.length);
  });

  describe('the rendered message is the registered text with the variables in order', () => {
    const cases: [string, Record<string, unknown>, string][] = [
      [
        NotificationType.BOOKING_CONFIRMED,
        {
          reference: 'ETG-IN-2026-000042',
          eventTitle: 'Kalki 2898 AD',
          startsAt: '2026-11-01T13:30:00.000Z',
          timeZone: 'Asia/Kolkata',
        },
        'ETicketsGo: Booking ETG-IN-2026-000042 for Kalki 2898 AD on 01 Nov 2026, 07:00 PM is confirmed. Your tickets are in your email and in your account. - DeepTrics',
      ],
      [
        NotificationType.BOOKING_CANCELLED,
        { reference: 'ETG-IN-2026-000042' },
        'ETicketsGo: Booking ETG-IN-2026-000042 is cancelled. Check your email for refund details. - DeepTrics',
      ],
      [
        NotificationType.REFUND_COMPLETED,
        { reference: 'ETG-IN-2026-000042', amountMinor: 125050, currency: 'INR' },
        'ETicketsGo: We have refunded Rs 1250.50 for booking ETG-IN-2026-000042. Your bank may take a few working days to show it. - DeepTrics',
      ],
      [
        NotificationType.SHOW_CANCELLED,
        {
          reference: 'ETG-IN-2026-000042',
          eventTitle: 'Kalki 2898 AD',
          startsAt: '2026-11-01T13:30:00.000Z',
          timeZone: 'Asia/Kolkata',
        },
        'ETicketsGo: Kalki 2898 AD on 01 Nov 2026, 07:00 PM is cancelled. Booking ETG-IN-2026-000042. Check your email for refund details. - DeepTrics',
      ],
    ];

    it.each(cases)('%s', (kind, payload, expected) => {
      const t = DLT_SMS_TEMPLATES[kind as keyof typeof DLT_SMS_TEMPLATES];
      const result = dltVariablesFromPayload(t, payload);
      expect('values' in result).toBe(true);
      const values = (result as { values: string[] }).values;
      const rendered = renderDltSms(t, values);
      expect(rendered).toBe(expected);
      // The operator's check: the same fixed text, every variable within its limit.
      expect(matchDltSms(t, rendered)).toEqual(values);
      values.forEach((v) => expect(v.length).toBeLessThanOrEqual(DLT_VARIABLE_MAX_LENGTH));
    });

    it('the sign-in code text, filled as PhoneOtpService fills it', () => {
      const t = DLT_SMS_TEMPLATES[OTP_SMS_KIND];
      expect(renderDltSms(t, ['042917', '10'])).toBe(
        '042917 is your ETicketsGo sign-in code. It expires in 10 minutes. Never share it with anyone.',
      );
    });
  });

  it('PhoneOtpService default text is the registered sign-in wording', () => {
    /*
      The OTP body is rendered in the auth code, which this change does not touch. Its default
      must be the registered text, or every code in India is refused before it is sent.
    */
    const src = readFileSync(join(__dirname, '../../auth/phone-otp.service.ts'), 'utf8');
    const m = src.match(/'(\{code\} is your [^']+)'/);
    expect(m).not.toBeNull();
    const asDlt = (m as RegExpMatchArray)[1]
      .replace('{code}', DLT_VARIABLE)
      .replace('{minutes}', DLT_VARIABLE);
    expect(asDlt).toBe(DLT_SMS_TEMPLATES[OTP_SMS_KIND].text);
  });

  it('names what is missing instead of rendering a blank', () => {
    const t = DLT_SMS_TEMPLATES[NotificationType.SHOW_CANCELLED];
    expect(dltVariablesFromPayload(t, { reference: 'R1', eventTitle: '  ' })).toEqual({
      missing: ['event', 'when'],
    });
  });

  it('does not match wording that differs from the registration, by one character', () => {
    const t = DLT_SMS_TEMPLATES[OTP_SMS_KIND];
    expect(
      matchDltSms(
        t,
        '042917 is your ETicketsGo sign-in code. It expires in 10 minutes. Never share it with anyone',
      ),
    ).toBeNull();
    // A variable longer than DLT allows is not the registered message either.
    expect(
      matchDltSms(
        t,
        `${'9'.repeat(31)} is your ETicketsGo sign-in code. It expires in 10 minutes. Never share it with anyone.`,
      ),
    ).toBeNull();
  });

  it('shortens a long event title to fit one variable, visibly', () => {
    const out = fitDltVariable('The Extraordinarily Long Name Of A Festival Night Two');
    expect(out.length).toBeLessThanOrEqual(DLT_VARIABLE_MAX_LENGTH);
    expect(out.endsWith('...')).toBe(true);
  });

  it('formats money from integer minor units, never a float', () => {
    expect(formatMinor(5, 'INR')).toBe('Rs 0.05');
    expect(formatMinor('125000', 'INR')).toBe('Rs 1250.00');
    expect(formatMinor(12.5, 'INR')).toBe('');
    expect(formatMinor(100, '')).toBe('');
  });

  describe('the owner docs page', () => {
    it.each(all.map((t) => [t.kind, t] as const))(
      'carries the exact %s text and both key names',
      (_kind, t) => {
        expect(DOC).toContain(t.text);
        expect(DOC).toContain(t.msg91TemplateIdEnv);
        expect(DOC).toContain(t.dltTemplateIdEnv);
      },
    );

    it('names the approved header and says the rejected one is rejected', () => {
      expect(DOC).toContain('DPTRCS');
      expect(DOC).toMatch(/ETKTGO[^\n]*REJECTED/);
    });
  });
});
