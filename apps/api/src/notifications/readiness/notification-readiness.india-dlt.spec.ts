import { ConfigService } from '@nestjs/config';
import { NotificationReadinessService } from './notification-readiness.service';
import { TemplateBindingService } from '../templates/template-binding.service';

/**
 * What readiness says about India SMS while DLT is part-way done.
 *
 * ── THE GAP THIS CLOSES ────────────────────────────────────────────────────────────
 * Readiness asked only about notification TYPES that policy routes to SMS. The sign-in code
 * is not a type, so India SMS could read complete with no OTP template at all -- and every
 * phone sign-in would then be refused at send time. It also had no idea a header could be one
 * the portal had rejected.
 */

/** Everything except the template ids: DPTRCS approved, PE recorded, MSG91 account set. */
const INDIA = {
  APP_ENV: 'QA',
  SMS_PROVIDER_BY_MARKET: 'IN=msg91',
  NOTIFICATION_MARKETS: 'IN',
  MSG91_AUTH_KEY: 'k',
  MSG91_SENDER_ID: 'DPTRCS',
  DLT_SENDER_HEADER: 'DPTRCS',
  DLT_PRINCIPAL_ENTITY_ID: '1701179092181018311',
  MSG91_WEBHOOK_SECRET: 's',
};

const ALL_REQUIRED_IDS = {
  MSG91_SMS_TEMPLATE_OTP: 'tmpl-otp',
  DLT_TEMPLATE_ID_OTP: '1707000000000000009',
  MSG91_SMS_TEMPLATE_SHOW_CANCELLED: 'tmpl-show',
  DLT_TEMPLATE_ID_SHOW_CANCELLED: '1707000000000000010',
};

function build(values: Record<string, string>) {
  const config = new ConfigService(values);
  const prisma = {
    notificationRate: { findFirst: jest.fn().mockResolvedValue({ id: 'rate' }) },
    webhookEvent: { count: jest.fn().mockResolvedValue(0) },
  };
  return new NotificationReadinessService(
    config,
    prisma as never,
    new TemplateBindingService(config),
  );
}

const sms = async (values: Record<string, string>) =>
  (await build(values).forMarket('IN')).components.find((c) => c.key === 'sms')!;

describe('readiness: India SMS and DLT templates', () => {
  it('is BLOCKED_DLT with no template ids, and names the sign-in code first', async () => {
    const c = await sms(INDIA);
    expect(c.state).toBe('BLOCKED_DLT');
    expect(c.missingExternal).toEqual(
      expect.arrayContaining([
        'Sign-in code (OTP): MSG91_SMS_TEMPLATE_OTP, DLT_TEMPLATE_ID_OTP',
        'Show cancelled: MSG91_SMS_TEMPLATE_SHOW_CANCELLED, DLT_TEMPLATE_ID_SHOW_CANCELLED',
      ]),
    );
  });

  it('stays blocked when only the notification template is approved, not the sign-in code', async () => {
    const c = await sms({
      ...INDIA,
      MSG91_SMS_TEMPLATE_SHOW_CANCELLED: 'tmpl-show',
      DLT_TEMPLATE_ID_SHOW_CANCELLED: '1707000000000000010',
    });
    expect(c.state).toBe('BLOCKED_DLT');
    expect(c.detail).toContain('MSG91_SMS_TEMPLATE_OTP');
    expect(c.detail).not.toContain('SHOW_CANCELLED');
  });

  it('stays blocked when the MSG91 id is set but the DLT approval is not recorded', async () => {
    const c = await sms({ ...INDIA, ...ALL_REQUIRED_IDS, DLT_TEMPLATE_ID_OTP: '' });
    expect(c.state).toBe('BLOCKED_DLT');
    expect(c.detail).toContain('DLT_TEMPLATE_ID_OTP');
  });

  it('is configured once both required templates have both ids', async () => {
    const c = await sms({ ...INDIA, ...ALL_REQUIRED_IDS });
    expect(c.state).toBe('CONFIGURED');
  });

  it('does not ask for the optional templates policy never sends by SMS', async () => {
    const c = await sms(INDIA);
    expect(c.detail).not.toContain('BOOKING_CONFIRMED');
    expect(c.detail).not.toContain('REFUND_COMPLETED');
  });

  // Owner, 2026-10-25: header ETKTGO is approved.
  it('accepts ETKTGO when configured with valid ids', async () => {
    const c = await sms({
      ...INDIA,
      ...ALL_REQUIRED_IDS,
      MSG91_SENDER_ID: 'ETKTGO',
      DLT_SENDER_HEADER: 'ETKTGO',
    });
    expect(c.state).toBe('CONFIGURED');
    expect(c.detail ?? '').not.toContain('rejected');
  });

  it('still reports BLOCKED_DLT for ETKTGO without the template ids', async () => {
    const c = await sms({ ...INDIA, MSG91_SENDER_ID: 'ETKTGO', DLT_SENDER_HEADER: 'ETKTGO' });
    expect(c.state).toBe('BLOCKED_DLT');
    expect(c.detail).toContain('DLT_TEMPLATE_ID_OTP');
  });

  it('never prints a configured value, only key names', async () => {
    const c = await sms({ ...INDIA, MSG91_SMS_TEMPLATE_SHOW_CANCELLED: 'tmpl-show' });
    expect(JSON.stringify(c)).not.toContain('tmpl-show');
    expect(JSON.stringify(c)).not.toContain('1701179092181018311');
  });
});
