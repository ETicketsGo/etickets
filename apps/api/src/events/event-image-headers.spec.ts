import { sendEventImage } from './events.controller';

/**
 * Every response that carries an image must say it may be loaded cross-origin.
 *
 * ── THE BUG ────────────────────────────────────────────────────────────────────────
 * `Cross-Origin-Resource-Policy` is checked against EVERY response in a redirect chain, not only
 * the one carrying the bytes. When the object moved to a public bucket, the new redirect branch
 * set `Cache-Control` and nothing else, so helmet's default `same-origin` went out on the 301 -
 * and the browser refused the image before it ever followed the redirect.
 *
 * The object was in R2, the bucket was public, and `curl` fetched it without complaint, because
 * curl does not enforce CORP. Every `<img>` on the storefront was broken and an end-to-end check
 * that looked thorough passed anyway. This test covers both branches for that reason.
 */
describe('an event image says it may be loaded cross-origin', () => {
  const fakeRes = () => {
    const headers: Record<string, string> = {};
    return {
      headers,
      setHeader: (k: string, v: string) => {
        headers[k] = v;
      },
      redirect: jest.fn(),
      status: jest.fn().mockReturnThis(),
      end: jest.fn(),
      json: jest.fn(),
    };
  };

  it('on the redirect to the bucket', () => {
    const res = fakeRes();
    sendEventImage(
      res as never,
      {
        redirectTo: 'https://cdn.example/obj.png',
        contentType: 'image/png',
        sha256: 'a'.repeat(64),
      },
      undefined,
      undefined,
    );
    expect(res.redirect).toHaveBeenCalledWith(301, 'https://cdn.example/obj.png');
    expect(res.headers['Cross-Origin-Resource-Policy']).toBe('cross-origin');
  });

  it('on the bytes it serves itself', () => {
    const res = fakeRes();
    sendEventImage(
      res as never,
      { bytes: new Uint8Array([1, 2, 3]), contentType: 'image/png', sha256: 'b'.repeat(64) },
      undefined,
      undefined,
    );
    expect(res.headers['Cross-Origin-Resource-Policy']).toBe('cross-origin');
    // The rest of the hardening travels with it: the bytes can only ever render as an image.
    expect(res.headers['X-Content-Type-Options']).toBe('nosniff');
  });
});
