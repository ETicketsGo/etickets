import {
  eventImageKey,
  eventPrefix,
  extensionFor,
  isPublicKey,
  organizationDocumentKey,
  organizationImageKey,
  organizationPrefix,
  PRIVATE_PREFIX,
  PUBLIC_PREFIX,
} from './object-keys';

/**
 * Where objects live in the bucket.
 *
 * The layout is the security boundary as much as it is an organising idea: `public/` and
 * `private/` map to two different buckets because R2 grants public access per bucket, so a key
 * built under the wrong prefix is an identity document behind a guessable URL. These tests are
 * about that first, and tidiness second.
 */
describe('object keys', () => {
  it('puts everything a customer may see under the public prefix', () => {
    expect(
      isPublicKey(
        eventImageKey({ eventId: 'ev1', sha256: 'a'.repeat(64), contentType: 'image/jpeg' }),
      ),
    ).toBe(true);
    expect(
      isPublicKey(
        organizationImageKey({
          organizationId: 'org1',
          kind: 'LOGO',
          sha256: 'b'.repeat(64),
          contentType: 'image/png',
        }),
      ),
    ).toBe(true);
  });

  it('puts an identity document under the private prefix, and never the public one', () => {
    // The single most important assertion in this file.
    const key = organizationDocumentKey({
      organizationId: 'org1',
      documentId: 'doc1',
      contentType: 'application/pdf',
    });
    expect(key.startsWith(PRIVATE_PREFIX)).toBe(true);
    expect(isPublicKey(key)).toBe(false);
    expect(key).not.toContain(PUBLIC_PREFIX);
  });

  it('names a picture after its contents, so replacing one is a different address', () => {
    const one = eventImageKey({
      eventId: 'ev1',
      sha256: 'a'.repeat(64),
      contentType: 'image/jpeg',
    });
    const two = eventImageKey({
      eventId: 'ev1',
      sha256: 'c'.repeat(64),
      contentType: 'image/jpeg',
    });
    expect(one).not.toEqual(two);
    // And the same bytes are the same key, which is what makes a retried upload harmless.
    expect(
      eventImageKey({ eventId: 'ev1', sha256: 'a'.repeat(64), contentType: 'image/jpeg' }),
    ).toEqual(one);
  });

  it('groups by owner, so an event’s images can be found and removed together', () => {
    const key = eventImageKey({
      eventId: 'ev1',
      sha256: 'a'.repeat(64),
      contentType: 'image/webp',
    });
    expect(key.startsWith(eventPrefix('ev1'))).toBe(true);
    expect(key.startsWith(eventPrefix('ev2'))).toBe(false);

    const logo = organizationImageKey({
      organizationId: 'org1',
      kind: 'COVER',
      sha256: 'd'.repeat(64),
      contentType: 'image/png',
    });
    expect(logo.startsWith(organizationPrefix('org1'))).toBe(true);
  });

  it('keeps two kinds of organization picture apart', () => {
    const args = { organizationId: 'org1', sha256: 'e'.repeat(64), contentType: 'image/png' };
    expect(organizationImageKey({ ...args, kind: 'LOGO' })).not.toEqual(
      organizationImageKey({ ...args, kind: 'COVER' }),
    );
  });

  it('refuses an id that could climb out of its prefix', () => {
    /*
      A traversal in an id would let one owner's key address another owner's object, or escape
      the prefix a lifecycle rule is written against. Refused rather than sanitised: an id with
      a slash in it is a bug somewhere upstream, and quietly rewriting it hides that.
    */
    for (const bad of ['../other', 'a/b', 'a\\b', '..', '']) {
      expect(() =>
        eventImageKey({ eventId: bad, sha256: 'a'.repeat(64), contentType: 'image/jpeg' }),
      ).toThrow(/unsafe/i);
    }
  });

  it('gives a human-readable extension, and never fails over one', () => {
    expect(extensionFor('image/jpeg')).toBe('jpg');
    expect(extensionFor('image/png')).toBe('png');
    expect(extensionFor('application/pdf')).toBe('pdf');
    // Charset parameters and casing are the provider's business, not ours.
    expect(extensionFor('IMAGE/PNG; charset=binary')).toBe('png');
    /*
      `bin` rather than a throw. What an object IS is decided by the content type on its row,
      sniffed from the bytes; the extension is a convenience for a human reading the bucket, and
      refusing to store a file over one would turn a cosmetic problem into a failed upload.
    */
    expect(extensionFor('application/x-made-up')).toBe('bin');
  });
});
