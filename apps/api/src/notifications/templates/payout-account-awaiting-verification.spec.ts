import { NotificationType } from '@eticketsgo/shared-types';
import { NotificationTemplateService } from './notification-template.service';

/**
 * The notice staff get when an organizer's bank account is waiting for them.
 *
 * It must say which account (masked), that no payout can go to it yet, and - the reason this
 * message exists at all - that somebody other than the person who entered it has to do the check.
 */
describe('PAYOUT_ACCOUNT_AWAITING_VERIFICATION template', () => {
  const templates = new NotificationTemplateService();
  const payload = {
    organizationName: 'DeepTrics',
    currency: 'INR',
    bankName: 'State Bank of India',
    accountLast4: '4567',
    version: 1,
    changedFields: ['initial'],
    savedByEmail: 'owner@example.com',
  };

  it('names the account masked, says who entered it, and that someone else must verify it', () => {
    const out = templates.render(
      NotificationType.PAYOUT_ACCOUNT_AWAITING_VERIFICATION,
      'en',
      payload,
    );
    expect(out.subject).toBe('Bank account waiting for verification: DeepTrics');
    expect(out.body).toContain('State Bank of India, ending 4567');
    expect(out.body).toContain('a new account');
    expect(out.body).toContain('Entered by owner@example.com');
    expect(out.body).toContain(
      'A staff member other than the person who entered these details must verify them',
    );
    expect(out.body).toContain('No payout can go to it until it is verified');
    expect(out.body).not.toContain('{');
    // ASCII only, as house copy is.
    expect(/^[\x20-\x7e]*$/.test(out.subject + out.body)).toBe(true);
  });

  it('lists what changed on a replacement', () => {
    const out = templates.render(NotificationType.PAYOUT_ACCOUNT_AWAITING_VERIFICATION, 'en', {
      ...payload,
      version: 3,
      changedFields: ['accountNumber', 'bankCode'],
    });
    expect(out.body).toContain('Changed: account number, bank code.');
    expect(out.body).toContain('(version 3)');
  });

  it('has a French version with no missing placeholder', () => {
    const out = templates.render(
      NotificationType.PAYOUT_ACCOUNT_AWAITING_VERIFICATION,
      'fr-CA',
      payload,
    );
    expect(out.body).toContain('4567');
    expect(out.body).not.toContain('{');
  });
});
