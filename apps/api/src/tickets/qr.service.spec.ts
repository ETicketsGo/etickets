import { ConfigService } from '@nestjs/config';
import { QrService } from './qr.service';

function makeService(secret = 'qr-secret') {
  return new QrService({ getOrThrow: () => secret } as unknown as ConfigService);
}

const ticket = { ticketId: 'tk_1', eventSessionId: 'se_1', nonce: 'abcd1234', version: 1 };

describe('QrService', () => {
  it('signs and verifies a valid token round-trip', () => {
    const svc = makeService();
    const token = svc.sign(ticket);
    const payload = svc.verify(token);
    expect(payload.ticketId).toBe('tk_1');
    expect(payload.eventSessionId).toBe('se_1');
    expect(payload.version).toBe(1);
  });

  it('rejects a token signed with a different secret', () => {
    const token = makeService('secret-a').sign(ticket);
    expect(() => makeService('secret-b').verify(token)).toThrow(/signature/i);
  });

  it('rejects a tampered payload', () => {
    const svc = makeService();
    const token = svc.sign(ticket);
    const decoded = JSON.parse(Buffer.from(token, 'base64url').toString('utf8'));
    decoded.ticketId = 'tk_hacked';
    const tampered = Buffer.from(JSON.stringify(decoded)).toString('base64url');
    expect(() => svc.verify(tampered)).toThrow(/signature/i);
  });

  it('rejects garbage input', () => {
    expect(() => makeService().verify('not-a-token')).toThrow();
  });
});
