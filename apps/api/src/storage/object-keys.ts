/**
 * Where every object lives in the bucket, decided in one place.
 *
 * ── WHY THE LAYOUT IS A FUNCTION AND NOT A CONVENTION ──────────────────────────────
 * A bucket whose keys were each invented at their call site is a bucket nobody can audit,
 * lifecycle-rule, or clean up after a deleted event. Keys are built here so that "what is in
 * this bucket and who does it belong to" is answerable by reading one file.
 *
 * ── THE SHAPE ──────────────────────────────────────────────────────────────────────
 *
 *   public/events/<eventId>/<sha256>.<ext>
 *   public/organizations/<organizationId>/<kind>/<sha256>.<ext>
 *   private/organizations/<organizationId>/identity/<documentId>.<ext>
 *
 * Three things are load-bearing:
 *
 * **`public/` and `private/` at the top.** Visibility is a property of the object, and putting
 * it first means a bucket policy, a lifecycle rule or a CDN cache rule can be written against a
 * prefix rather than against a list of paths somebody has to keep in step. It also makes the
 * dangerous mistake — an identity document under a public prefix — visible in the key itself
 * rather than buried in a config file. These map to two separate buckets in R2 (public access
 * is granted per bucket, not per prefix), and the prefix is kept anyway so that one glance at a
 * key says which bucket it belongs in and a misfiled object is obvious.
 *
 * **The owner's id second.** Everything belonging to one event or one organization sits under a
 * single prefix, so deleting an event can delete its images with one prefix call, and an export
 * for an organization is one listing.
 *
 * **The content hash as the filename.** The key changes when the bytes change, so a replaced
 * poster is a new URL and no CDN, browser or proxy anywhere is holding a stale answer under the
 * new address. It also makes writes idempotent: uploading the same file twice writes the same
 * key twice, which costs nothing and corrupts nothing.
 */

/** The file extension for a content type we are willing to store. */
const EXTENSIONS: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'image/gif': 'gif',
  'application/pdf': 'pdf',
};

/**
 * The extension for a content type, or `bin`.
 *
 * `bin` rather than a throw: an extension is a convenience for a human reading the bucket, and
 * refusing to store an object over one would turn a cosmetic problem into a failed upload. What
 * the object IS is decided by the content type recorded on the row and sniffed from the bytes,
 * never by its key.
 */
export function extensionFor(contentType: string): string {
  return EXTENSIONS[contentType.toLowerCase().split(';')[0].trim()] ?? 'bin';
}

/** Rejects anything that could climb out of its prefix or collide with a directory marker. */
function segment(raw: string, label: string): string {
  const value = (raw ?? '').trim();
  if (!value || value.includes('/') || value.includes('\\') || value.includes('..')) {
    throw new Error(`Unsafe ${label} for an object key: ${JSON.stringify(raw)}`);
  }
  return value;
}

export const PUBLIC_PREFIX = 'public/';
export const PRIVATE_PREFIX = 'private/';

/** True when this key belongs in the bucket that the world can read. */
export function isPublicKey(key: string): boolean {
  return key.startsWith(PUBLIC_PREFIX);
}

/** An event's poster or gallery image. */
export function eventImageKey(input: {
  eventId: string;
  sha256: string;
  contentType: string;
}): string {
  return `${PUBLIC_PREFIX}events/${segment(input.eventId, 'event id')}/${segment(
    input.sha256,
    'content hash',
  )}.${extensionFor(input.contentType)}`;
}

/** An organization's logo or cover banner. */
export function organizationImageKey(input: {
  organizationId: string;
  kind: string;
  sha256: string;
  contentType: string;
}): string {
  return `${PUBLIC_PREFIX}organizations/${segment(
    input.organizationId,
    'organization id',
  )}/${segment(input.kind.toLowerCase(), 'image kind')}/${segment(
    input.sha256,
    'content hash',
  )}.${extensionFor(input.contentType)}`;
}

/**
 * A document an organization uploaded to prove who they are.
 *
 * Under `private/`, and keyed by the document's own id rather than its hash: two organizations
 * uploading the same certificate must not share a key, because deleting one organization's copy
 * would take the other's with it. Nothing here is ever served from a public URL.
 */
export function organizationDocumentKey(input: {
  organizationId: string;
  documentId: string;
  contentType: string;
}): string {
  return `${PRIVATE_PREFIX}organizations/${segment(
    input.organizationId,
    'organization id',
  )}/identity/${segment(input.documentId, 'document id')}.${extensionFor(input.contentType)}`;
}

/** Everything belonging to one event, for a delete or an export. */
export function eventPrefix(eventId: string): string {
  return `${PUBLIC_PREFIX}events/${segment(eventId, 'event id')}/`;
}

/** Everything belonging to one organization, public side. */
export function organizationPrefix(organizationId: string): string {
  return `${PUBLIC_PREFIX}organizations/${segment(organizationId, 'organization id')}/`;
}
