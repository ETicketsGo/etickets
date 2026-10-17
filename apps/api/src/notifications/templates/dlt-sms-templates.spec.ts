import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { NotificationType } from '@eticketsgo/shared-types';
import {
  DLT_SMS_REPLACEMENTS,
  DLT_SMS_TEMPLATES,
  DLT_VARIABLE,
  DLT_VARIABLE_MAX_LENGTH,
  OTP_SMS_KIND,
  dltVariablesFromPayload,
  fitDltVariable,
  formatMinor,
  matchDltSms,
  renderDltSms,
  selectDltTemplate,
  type DltSmsTemplate,
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
const REPLACEMENT_PACK = readFileSync(
  join(__dirname, '../../../../../docs/notifications/INDIA-DLT-SHOW-CANCELLED-REPLACEMENT.md'),
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

/**
 * The replacement show-cancelled wording (owner, 2026-10-16): register the corrected text, keep
 * the approved one until the replacement is approved.
 *
 * ── WHAT THIS PINS ─────────────────────────────────────────────────────────────────
 * With no new id set, nothing changes for an online buyer: the registered template is chosen,
 * and it renders exactly the text pinned above. A cash buyer is never sent the refund wording.
 * Once an id is set, its wording is chosen for its reader only. Whatever is chosen, the text it
 * renders is an instance of that template: the operator's own check.
 */
describe('replacement show-cancelled wording', () => {
  const SHOW = NotificationType.SHOW_CANCELLED;
  const online = {
    reference: 'ETG-IN-2026-000042',
    eventTitle: 'Kalki 2898 AD',
    startsAt: '2026-11-01T13:30:00.000Z',
    timeZone: 'Asia/Kolkata',
  };
  const cash = { ...online, paidInCash: true, amountMinor: 165036, currency: 'INR' };
  const organizerCopy = { ...cash, cashRecipient: 'ORGANIZER', buyerName: 'Walk Buyer' };
  const ONLINE_ID = 'DLT_TEMPLATE_ID_SHOW_CANCELLED_ONLINE';
  const CASH_ID = 'DLT_TEMPLATE_ID_SHOW_CANCELLED_CASH';
  const settings =
    (values: Record<string, string> = {}) =>
    (key: string): string | undefined =>
      values[key];
  const replacementFor = (key: string): DltSmsTemplate =>
    DLT_SMS_REPLACEMENTS.find((r) => r.dltTemplateIdEnv === key) as DltSmsTemplate;

  function rendered(t: DltSmsTemplate, payload: Record<string, unknown>): string {
    const result = dltVariablesFromPayload(t, payload);
    expect('values' in result).toBe(true);
    const values = (result as { values: string[] }).values;
    const text = renderDltSms(t, values);
    // The guard: a rendered message must be an instance of the template it was chosen from.
    expect(matchDltSms(t, text)).toEqual(values);
    return text;
  }

  it.each(DLT_SMS_REPLACEMENTS.map((t) => [t.label, t] as const))(
    '%s is registrable: ASCII, service implicit, no link, its own keys, two segments at most',
    (_label, t) => {
      expect(t.text).toMatch(/^[\x20-\x7E]+$/);
      expect(t.text.split(DLT_VARIABLE).length - 1).toBe(t.variables.length);
      expect(t.category).toBe('SERVICE_IMPLICIT');
      expect(t.text).not.toMatch(/https?:|www\./i);
      expect(t.text).not.toMatch(/email/i);
      // Every variable at its DLT maximum still fits two GSM-7 parts (2 x 153).
      const fixed = t.text.split(DLT_VARIABLE).join('').length;
      expect(fixed + t.variables.length * DLT_VARIABLE_MAX_LENGTH).toBeLessThanOrEqual(306);
      const registeredKeys = Object.values(DLT_SMS_TEMPLATES).flatMap((r) => [
        r.msg91TemplateIdEnv,
        r.dltTemplateIdEnv,
      ]);
      expect(registeredKeys).not.toContain(t.msg91TemplateIdEnv);
      expect(registeredKeys).not.toContain(t.dltTemplateIdEnv);
    },
  );

  it('with no new id set, an online buyer gets the registered template, unchanged', () => {
    expect(selectDltTemplate(SHOW, online, settings())).toEqual({
      template: DLT_SMS_TEMPLATES[SHOW],
      replacement: false,
    });
    expect(rendered(DLT_SMS_TEMPLATES[SHOW], online)).toBe(
      'ETicketsGo: Kalki 2898 AD on 01 Nov 2026, 07:00 PM is cancelled. Booking ETG-IN-2026-000042. Check your email for refund details. - DeepTrics',
    );
  });

  it('with no cash id set, a cash buyer gets no SMS rather than the refund wording', () => {
    // Even with the online replacement approved: that text speaks of a refund too.
    const chosen = selectDltTemplate(SHOW, cash, settings({ [ONLINE_ID]: '1707000000000000020' }));
    expect(chosen).toHaveProperty('refused');
    const reason = (chosen as { refused: string }).refused;
    expect(reason).toContain(CASH_ID);
    expect(reason).toContain('MSG91_SMS_TEMPLATE_SHOW_CANCELLED_CASH');
  });

  it('the organization copy of a walk-up message is never an SMS, whatever is set', () => {
    const chosen = selectDltTemplate(
      SHOW,
      organizerCopy,
      settings({ [ONLINE_ID]: '1707000000000000020', [CASH_ID]: '1707000000000000021' }),
    );
    expect(chosen).toHaveProperty('refused');
  });

  it('once approved, the online wording is chosen for an online buyer only', () => {
    const set = settings({ [ONLINE_ID]: '1707000000000000020' });
    const chosen = selectDltTemplate(SHOW, online, set) as { template: DltSmsTemplate };
    expect(chosen.template).toBe(replacementFor(ONLINE_ID));
    expect(rendered(chosen.template, online)).toBe(
      'ETicketsGo: Kalki 2898 AD on 01 Nov 2026, 07:00 PM is cancelled. Booking ETG-IN-2026-000042. Your refund will go to the account you paid from. - DeepTrics',
    );
  });

  it('once approved, the cash wording is chosen for a cash buyer, with the amount', () => {
    const set = settings({ [CASH_ID]: '1707000000000000021' });
    const chosen = selectDltTemplate(SHOW, cash, set) as { template: DltSmsTemplate };
    expect(chosen.template).toBe(replacementFor(CASH_ID));
    const text = rendered(chosen.template, cash);
    expect(text).toBe(
      'ETicketsGo: Kalki 2898 AD on 01 Nov 2026, 07:00 PM is cancelled. Booking ETG-IN-2026-000042. You paid Rs 1650.36 in cash. Show this booking at the venue box office to get your cash back. - DeepTrics',
    );
    expect(text).not.toMatch(/refund/i);
    // The cash id leaves an online buyer on the registered template.
    expect(selectDltTemplate(SHOW, online, set)).toEqual({
      template: DLT_SMS_TEMPLATES[SHOW],
      replacement: false,
    });
  });

  it('every other kind keeps its registered template, whatever the payload says', () => {
    const set = settings({ [ONLINE_ID]: '1707000000000000020', [CASH_ID]: '1707000000000000021' });
    for (const kind of Object.keys(DLT_SMS_TEMPLATES)) {
      if (kind === SHOW) continue;
      expect(selectDltTemplate(kind, cash, set)).toEqual({
        template: DLT_SMS_TEMPLATES[kind as keyof typeof DLT_SMS_TEMPLATES],
        replacement: false,
      });
    }
    expect(selectDltTemplate(NotificationType.PAYMENT_FAILED, online, set)).toBeNull();
  });

  it('a message that drifts from the chosen wording does not match it', () => {
    const text = rendered(replacementFor(CASH_ID), cash);
    expect(matchDltSms(replacementFor(CASH_ID), text.replace('box office', 'counter'))).toBeNull();
    // Nor does the cash text pass as the online wording or the registered one.
    expect(matchDltSms(replacementFor(ONLINE_ID), text)).toBeNull();
    expect(matchDltSms(DLT_SMS_TEMPLATES[SHOW], text)).toBeNull();
  });

  describe('the registration pack', () => {
    it.each(DLT_SMS_REPLACEMENTS.map((t) => [t.label, t] as const))(
      'carries the exact %s text, its MSG91 form and both key names',
      (_label, t) => {
        expect(REPLACEMENT_PACK).toContain(t.text);
        const msg91Form = t.variables.reduce(
          (text, name) => text.replace(DLT_VARIABLE, `##${name}##`),
          t.text,
        );
        expect(REPLACEMENT_PACK).toContain(msg91Form);
        expect(REPLACEMENT_PACK).toContain(t.msg91TemplateIdEnv);
        expect(REPLACEMENT_PACK).toContain(t.dltTemplateIdEnv);
        // The main India page lists the keys too, so an operator reading only it finds them.
        expect(DOC).toContain(t.dltTemplateIdEnv);
        expect(DOC).toContain(t.msg91TemplateIdEnv);
      },
    );

    it('names the text it replaces and the approved header', () => {
      expect(REPLACEMENT_PACK).toContain(DLT_SMS_TEMPLATES[SHOW].text);
      expect(REPLACEMENT_PACK).toContain('DPTRCS');
      expect(REPLACEMENT_PACK).toMatch(/ETKTGO[^\n]*rejected/i);
    });
  });
});
