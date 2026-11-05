import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { NotificationType } from '@eticketsgo/shared-types';
import {
  DLT_ID_PATTERN,
  DLT_SMS_REPLACEMENTS,
  DLT_SMS_TEMPLATES,
  DLT_VARIABLE,
  DLT_VARIABLE_MAX_LENGTH,
  DOCUMENTED_APPROVED_SENDER_HEADERS,
  OTP_SMS_KIND,
  PASSWORD_UPDATE_SMS_KIND,
  PAYMENT_PENDING_SMS_KIND,
  REJECTED_SENDER_HEADERS,
  dltSendRefusal,
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
  // The templates whose wording this code holds. The others are approved but their text is
  // not known here, so they are unsendable (see "the eight approved DLT templates").
  const worded = all.filter((t): t is DltSmsTemplate & { text: string } => t.text !== null);

  it('covers the eight approved templates, plus the two kinds with no approval', () => {
    expect(Object.keys(DLT_SMS_TEMPLATES).sort()).toEqual(
      [
        OTP_SMS_KIND,
        NotificationType.BOOKING_CANCELLED,
        NotificationType.BOOKING_CONFIRMED,
        NotificationType.REFUND_COMPLETED,
        NotificationType.SHOW_CANCELLED,
        NotificationType.PASSWORD_RESET_REQUESTED,
        NotificationType.PASSWORD_CHANGED,
        NotificationType.EVENT_REMINDER,
        PASSWORD_UPDATE_SMS_KIND,
        PAYMENT_PENDING_SMS_KIND,
      ].sort(),
    );
  });

  it.each(worded.map((t) => [t.kind, t] as const))(
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
        'ETicketsGo: Your booking ETG-IN-2026-000042 for Kalki 2898 AD on 01 Nov 2026, 07:00 PM is confirmed. View your ticket in your account.',
      ],
      [
        NotificationType.BOOKING_CANCELLED,
        { reference: 'ETG-IN-2026-000042', eventTitle: 'Kalki 2898 AD' },
        'ETicketsGo: Your booking ETG-IN-2026-000042 for Kalki 2898 AD has been cancelled. Check your account for refund details, if applicable.',
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
      expect(renderDltSms(t, ['042917'])).toBe(
        'Your ETicketsGo verification code is 042917. Valid for 5 minutes. Do not share this code.',
      );
    });
  });

  it('a sign-in code lives exactly as long as the registered text says', () => {
    // The approved wording fixes the lifetime ("Valid for 5 minutes"); the code must match it.
    const src = readFileSync(join(__dirname, '../../auth/phone-otp.service.ts'), 'utf8');
    const ttl = src.match(/const OTP_TTL_MINUTES = (\d+);/);
    expect(ttl).not.toBeNull();
    expect(DLT_SMS_TEMPLATES[OTP_SMS_KIND].text).toContain(`Valid for ${ttl![1]} minutes.`);
    expect(ttl![1]).toBe('5');
  });

  it('PhoneOtpService default text is the registered sign-in wording', () => {
    /*
      The OTP body is rendered in the auth code, which this change does not touch. Its default
      must be the registered text, or every code in India is refused before it is sent.
    */
    const src = readFileSync(join(__dirname, '../../auth/phone-otp.service.ts'), 'utf8');
    const m = src.match(/'(Your ETicketsGo verification code is \{code\}[^']+)'/);
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
        'Your ETicketsGo verification code is 042917. Valid for 5 minutes. Do not share this code',
      ),
    ).toBeNull();
    // A variable longer than DLT allows is not the registered message either.
    expect(
      matchDltSms(
        t,
        `Your ETicketsGo verification code is ${'9'.repeat(31)}. Valid for 5 minutes. Do not share this code.`,
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
        if (t.text !== null) expect(DOC).toContain(t.text);
        expect(DOC).toContain(t.msg91TemplateIdEnv);
        expect(DOC).toContain(t.dltTemplateIdEnv);
      },
    );

    it('names both approved headers and records the owner statement for ETKTGO', () => {
      expect(DOC).toContain('DPTRCS');
      expect(DOC).toMatch(/ETKTGO[^\n]*APPROVED/);
      expect(DOC).toContain('2026-10-25');
      expect(DOC).not.toMatch(/ETKTGO[^\n]*REJECTED - never configure/);
    });
  });

  /*
    Owner, 2026-10-25: header ETKTGO, the PE-TM chain and eight templates are approved. The
    rejected list stays as a mechanism, so a future rejection is one line to re-add.
  */
  describe('sender headers', () => {
    it('treats ETKTGO and DPTRCS as approved', () => {
      expect(DOCUMENTED_APPROVED_SENDER_HEADERS).toEqual(
        expect.arrayContaining(['ETKTGO', 'DPTRCS']),
      );
    });

    it('rejects neither approved header', () => {
      for (const header of DOCUMENTED_APPROVED_SENDER_HEADERS) {
        expect(REJECTED_SENDER_HEADERS).not.toContain(header);
      }
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
      expect(REPLACEMENT_PACK).toContain('ETKTGO');
      expect(REPLACEMENT_PACK).not.toMatch(/ETKTGO[^\n]*rejected/i);
    });
  });
});

/*
  The owner's eight approved DLT templates (2026-10-28), pinned: which kind sends under which
  approval, the 19-digit DLT id, the configuration keys, and the variable order. MSG91's own
  ids are configuration only. The registered TEXT could not be read from MSG91 (it has no list
  API), so every one is textVerified=false and therefore refused until somebody copies it in.
*/
describe('the eight approved DLT templates', () => {
  const APPROVED: [string, string, string, string, string, string[]][] = [
    // name, kind, DLT id, MSG91 key, DLT key, variables in order
    [
      'OTP_LOGIN',
      OTP_SMS_KIND,
      '1777179239436687127',
      'MSG91_SMS_TEMPLATE_OTP',
      'DLT_TEMPLATE_ID_OTP',
      ['otp'],
    ],
    [
      'PASSWORD_RESET',
      NotificationType.PASSWORD_RESET_REQUESTED,
      '1777179240353412789',
      'MSG91_SMS_TEMPLATE_PASSWORD_RESET',
      'DLT_TEMPLATE_ID_PASSWORD_RESET',
      ['code'],
    ],
    [
      'PASSWORD_CHANGE',
      NotificationType.PASSWORD_CHANGED,
      '1777179240360916280',
      'MSG91_SMS_TEMPLATE_PASSWORD_CHANGE',
      'DLT_TEMPLATE_ID_PASSWORD_CHANGE',
      [],
    ],
    [
      'PASSWORD_UPDATE',
      PASSWORD_UPDATE_SMS_KIND,
      '1777179239457786914',
      'MSG91_SMS_TEMPLATE_PASSWORD_UPDATE',
      'DLT_TEMPLATE_ID_PASSWORD_UPDATE',
      [],
    ],
    [
      'BOOKING_CONFIRMED',
      NotificationType.BOOKING_CONFIRMED,
      '1777179239474119451',
      'MSG91_SMS_TEMPLATE_BOOKING_CONFIRMED',
      'DLT_TEMPLATE_ID_BOOKING_CONFIRMED',
      ['reference', 'event', 'when'],
    ],
    [
      'BOOKING_CANCELLED',
      NotificationType.BOOKING_CANCELLED,
      '1777179239566169492',
      'MSG91_SMS_TEMPLATE_BOOKING_CANCELLED',
      'DLT_TEMPLATE_ID_BOOKING_CANCELLED',
      ['reference', 'event'],
    ],
    [
      'PAYMENT_PENDING',
      PAYMENT_PENDING_SMS_KIND,
      '1777179239515564360',
      'MSG91_SMS_TEMPLATE_PAYMENT_PENDING',
      'DLT_TEMPLATE_ID_PAYMENT_PENDING',
      ['reference'],
    ],
    [
      'EVENT_REMINDER',
      NotificationType.EVENT_REMINDER,
      '1777179240387088578',
      'MSG91_SMS_TEMPLATE_EVENT_REMINDER',
      'DLT_TEMPLATE_ID_EVENT_REMINDER',
      ['event', 'when'],
    ],
  ];

  it('there are exactly eight, with distinct DLT ids', () => {
    const approved = Object.values(DLT_SMS_TEMPLATES).filter((t) => t.approved);
    expect(approved.map((t) => t.approved!.name).sort()).toEqual(APPROVED.map((a) => a[0]).sort());
    expect(new Set(approved.map((t) => t.approved!.dltTemplateId)).size).toBe(8);
  });

  it.each(APPROVED)(
    '%s maps to its kind, DLT id, keys and variables',
    (name, kind, dltId, msg91Key, dltKey, vars) => {
      const t = DLT_SMS_TEMPLATES[kind as keyof typeof DLT_SMS_TEMPLATES];
      expect(t.approved).toEqual({ name, dltTemplateId: dltId });
      expect(dltId).toMatch(DLT_ID_PATTERN);
      expect(t.msg91TemplateIdEnv).toBe(msg91Key);
      expect(t.dltTemplateIdEnv).toBe(dltKey);
      expect(t.variables).toEqual(vars);
    },
  );

  /*
    Read back from MSG91 (getTemplateVersions, 2026-10-29): each MSG91 template, its DLT id,
    sender ETKTGO, wording and `##name##` variables. PASSWORD_UPDATE was added 2026-10-30.
  */
  const REGISTERED: Record<string, { msg91: string; vars: string[] } | null> = {
    OTP_LOGIN: {
      msg91:
        'Your ETicketsGo verification code is ##num##. Valid for 5 minutes. Do not share this code.',
      vars: ['num'],
    },
    PASSWORD_RESET: {
      msg91:
        'Your ETicketsGo password reset code is ##num##. Valid for 5 minutes. Do not share this code.',
      vars: ['num'],
    },
    PASSWORD_CHANGE: {
      msg91:
        'Your ETicketsGo password was changed successfully. If this was not you, contact our support team immediately.',
      vars: [],
    },
    PASSWORD_UPDATE: {
      msg91:
        'Your ETicketsGo password was changed successfully. If this was not you, contact our support team immediately.',
      vars: [],
    },
    BOOKING_CONFIRMED: {
      msg91:
        'ETicketsGo: Your booking ##alp1## for ##alp2## on ##alp3## is confirmed. View your ticket in your account.',
      vars: ['alp1', 'alp2', 'alp3'],
    },
    BOOKING_CANCELLED: {
      msg91:
        'ETicketsGo: Your booking ##alp1## for ##alp2## has been cancelled. Check your account for refund details, if applicable.',
      vars: ['alp1', 'alp2'],
    },
    PAYMENT_PENDING: {
      msg91:
        'ETicketsGo: Your booking ##alp## is awaiting payment confirmation. Check your booking status before making another payment.',
      vars: ['alp'],
    },
    EVENT_REMINDER: {
      msg91:
        'ETicketsGo: Reminder! Your event ##alp1## is scheduled for ##alp2##. Please carry your ticket QR code for entry.',
      vars: ['alp1', 'alp2'],
    },
  };

  it.each(APPROVED)('%s matches its MSG91 registration, or is unsendable', (name, kind, dltId) => {
    const t = DLT_SMS_TEMPLATES[kind as keyof typeof DLT_SMS_TEMPLATES];
    const reg = REGISTERED[name];
    if (!reg) {
      expect(t.textVerified).toBe(false);
      expect(dltSendRefusal(t, dltId)).toMatch(/unverified/);
      return;
    }
    expect(t.textVerified).toBe(true);
    const names = t.msg91Variables ?? t.variables;
    expect(names).toEqual(reg.vars);
    expect(
      t
        .text!.split(DLT_VARIABLE)
        .reduce((o, p, i) => (i === 0 ? p : `${o}##${names[i - 1]}##${p}`), ''),
    ).toBe(reg.msg91);
    expect(dltSendRefusal(t, dltId)).toBeNull();
  });

  it('show cancelled and refund have no approved template, so MSG91 never sends them', () => {
    for (const t of [
      DLT_SMS_TEMPLATES[NotificationType.SHOW_CANCELLED],
      DLT_SMS_TEMPLATES[NotificationType.REFUND_COMPLETED],
      ...DLT_SMS_REPLACEMENTS,
    ]) {
      expect(t.approved).toBeNull();
      expect(dltSendRefusal(t, '1777179239436687127')).toMatch(
        /no approved DLT template.*email only/,
      );
    }
  });

  it('a verified template sends only under its own approved DLT id', () => {
    const verified: DltSmsTemplate = { ...DLT_SMS_TEMPLATES[OTP_SMS_KIND], textVerified: true };
    expect(dltSendRefusal(verified, '1777179239436687127')).toBeNull();
    expect(dltSendRefusal(verified, undefined)).toBeNull();
    // Booking Confirmation's id in the OTP slot: two templates swapped.
    expect(dltSendRefusal(verified, '1777179239474119451')).toMatch(/not the approved DLT id/);
  });
});
