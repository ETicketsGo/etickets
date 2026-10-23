import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { connect } from 'node:net';
import { HTTP_TIMEOUT_DEFAULTS, applyHttpTimeouts, resolveHttpTimeouts } from './http-timeouts';

const none = () => undefined;

describe('HTTP server timeouts', () => {
  it('defaults keep idle connections open longer than the 60 s Railway edge', () => {
    const t = resolveHttpTimeouts(none);
    expect(t).toEqual(HTTP_TIMEOUT_DEFAULTS);
    expect(t.keepAliveTimeoutMs).toBeGreaterThan(60_000);
    expect(t.headersTimeoutMs).toBeGreaterThan(t.keepAliveTimeoutMs);
    expect(t.requestTimeoutMs).toBeGreaterThanOrEqual(t.headersTimeoutMs);
  });

  it('takes overrides, and keeps the ordering whatever the variables say', () => {
    const env: Record<string, string> = {
      HTTP_KEEP_ALIVE_TIMEOUT_MS: '90000',
      HTTP_HEADERS_TIMEOUT_MS: '30000',
      HTTP_REQUEST_TIMEOUT_MS: '10000',
    };
    const t = resolveHttpTimeouts((k) => env[k]);
    expect(t.keepAliveTimeoutMs).toBe(90_000);
    expect(t.headersTimeoutMs).toBe(91_000);
    expect(t.requestTimeoutMs).toBe(91_000);
  });

  it('ignores a value that is not a positive number', () => {
    const t = resolveHttpTimeouts((k) => (k === 'HTTP_KEEP_ALIVE_TIMEOUT_MS' ? 'abc' : '-5'));
    expect(t).toEqual(HTTP_TIMEOUT_DEFAULTS);
  });

  describe('on a real http.Server', () => {
    let server: Server;
    afterEach(async () => {
      await new Promise<void>((r) => server.close(() => r()));
    });

    it('sets all three values on the server', () => {
      server = createServer();
      applyHttpTimeouts(server, HTTP_TIMEOUT_DEFAULTS);
      expect(server.keepAliveTimeout).toBe(65_000);
      expect(server.headersTimeout).toBe(66_000);
      expect(server.requestTimeout).toBe(120_000);
      server.listen(0);
    });

    it('holds an idle keep-alive connection for the configured time, then closes it', async () => {
      // Shortened (1.5 s instead of 65 s) so the test is fast. Proves the server really uses the
      // value applied: the idle socket stays open for it, and the server then closes it.
      server = createServer((_req, res) => res.end('ok'));
      applyHttpTimeouts(server, {
        keepAliveTimeoutMs: 1_500,
        headersTimeoutMs: 2_500,
        requestTimeoutMs: 5_000,
      });
      await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
      const { port } = server.address() as AddressInfo;
      const sock = connect(port, '127.0.0.1');
      const closedAt = new Promise<number>((r) => sock.on('close', () => r(Date.now())));
      let answeredAt = 0;
      sock.on('data', () => {
        answeredAt ||= Date.now();
      });
      sock.write('GET / HTTP/1.1\r\nHost: x\r\nConnection: keep-alive\r\n\r\n');
      const closed = await closedAt;
      expect(answeredAt).toBeGreaterThan(0);
      expect(closed - answeredAt).toBeGreaterThanOrEqual(1_200);
      // And closed by OUR value, not Node default of 5 s.
      expect(closed - answeredAt).toBeLessThan(4_000);
    }, 10_000);
  });
});
