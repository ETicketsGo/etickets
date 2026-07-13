import { NotificationChannelRegistry } from './notification-channel.registry';
import { EmailChannel } from './email.channel';
import { SmsChannel } from './sms.channel';
import { WhatsAppChannel } from './whatsapp.channel';
import { PushChannel } from './push.channel';
import { InAppChannel } from './in-app.channel';

function registry() {
  return new NotificationChannelRegistry(
    new EmailChannel(),
    new SmsChannel(),
    new WhatsAppChannel(),
    new PushChannel(),
    new InAppChannel(),
  );
}

describe('NotificationChannelRegistry', () => {
  it('resolves each known channel key to a channel with a matching key', () => {
    const reg = registry();
    for (const key of ['email', 'sms', 'whatsapp', 'push', 'in_app'] as const) {
      const channel = reg.resolve(key);
      expect(channel).toBeDefined();
      expect(channel?.key).toBe(key);
    }
  });

  it('exposes all five keys', () => {
    expect(registry().keys().sort()).toEqual(['email', 'in_app', 'push', 'sms', 'whatsapp']);
  });

  it('has() narrows known keys and rejects unknown ones', () => {
    const reg = registry();
    expect(reg.has('email')).toBe(true);
    expect(reg.has('carrier-pigeon')).toBe(false);
    expect(reg.resolve('carrier-pigeon')).toBeUndefined();
  });
});
