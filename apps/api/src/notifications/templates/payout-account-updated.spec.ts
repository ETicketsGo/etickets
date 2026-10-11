import { NotificationType } from '@eticketsgo/shared-types';
import { NotificationTemplateService } from './notification-template.service';

/**
 * The email an owner gets when the bank account their money goes to changes.
 *
 * The payload only ever carries masked fields, so the wording cannot print a number; these tests
 * pin that the message says which account, what changed, and what to do if it was not them.
 */
describe('PAYOUT_ACCOUNT_UPDATED template', () => {
  const templates = new NotificationTemplateService();
  const base = {
    currency: 'INR',
    bankName: 'HDFC Bank',
    accountLast4: '4567',
    version: 2,
  };

  it('a change names the account, the changed fields, and what to do if it was not them', () => {
    const out = templates.render(NotificationType.PAYOUT_ACCOUNT_UPDATED, 'en', {
      ...base,
      change: 'SAVED',
      changedFields: ['accountNumber', 'bankName'],
    });
    expect(out.subject).toContain('INR');
    expect(out.body).toContain('HDFC Bank');
    expect(out.body).toContain('4567');
    expect(out.body).toContain('account number, bank name');
    expect(out.body).toContain('If this was not you, contact support');
    // The honest claim: waiting for verification. It does not promise a payout hold.
    expect(out.body).toContain('waiting for verification');
    expect(out.body).not.toContain('{');
  });

  it('a first save says it is a new account', () => {
    const out = templates.render(NotificationType.PAYOUT_ACCOUNT_UPDATED, 'en', {
      ...base,
      change: 'SAVED',
      changedFields: ['initial'],
    });
    expect(out.body).toContain('a new account');
  });

  it('a verification and a rejection each have their own words, and the rejection carries the reason', () => {
    const verified = templates.render(NotificationType.PAYOUT_ACCOUNT_UPDATED, 'en', {
      ...base,
      change: 'VERIFIED',
    });
    expect(verified.subject).toContain('verified');
    const rejected = templates.render(NotificationType.PAYOUT_ACCOUNT_UPDATED, 'en', {
      ...base,
      change: 'REJECTED',
      reason: 'Name does not match',
    });
    expect(rejected.subject).toContain('not accepted');
    expect(rejected.body).toContain('Name does not match');
  });

  it('renders in French for Quebec with nothing left unfilled', () => {
    for (const change of ['SAVED', 'VERIFIED', 'REJECTED']) {
      const out = templates.render(NotificationType.PAYOUT_ACCOUNT_UPDATED, 'fr-CA', {
        ...base,
        change,
        changedFields: ['holderName'],
        reason: 'Le nom ne correspond pas',
      });
      expect(out.body).toContain('4567');
      expect(out.body).not.toMatch(/[{}]/);
      expect(out.subject).not.toMatch(/[{}]/);
    }
  });
});
