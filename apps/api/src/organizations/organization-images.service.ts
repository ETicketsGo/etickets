import { HttpStatus, Injectable } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { Role } from '@eticketsgo/shared-types';
import { PrismaService } from '../prisma/prisma.service';
import { OrgAccessService } from '../tenancy/org-access.service';
import { AuditService } from '../audit/audit.service';
import { AppException, ErrorCodes } from '../common/errors';
import type { RequestUser } from '../common/decorators';
import { sniffImageType } from '../events/event-image';
import type { UploadedImageFile } from '../events/event-image.service';
import { ObjectStoreService } from '../storage/object-store.service';
import { organizationImageKey } from '../storage/object-keys';

/**
 * An organization's pictures: the profile picture, and the cover banner behind it.
 *
 * ── WHY THE PLATFORM HOLDS THE BYTES ───────────────────────────────────────────────
 * The field before this was a text box asking for a URL. Most organizers have nowhere to
 * host an image, the links that did arrive rotted, and a third-party URL rendered under this
 * platform's name is somebody else's server deciding what our customers see - including
 * after they change what is at that address. Event posters were moved into the database for
 * exactly these reasons; a logo is the same problem at a smaller size.
 *
 * ── WHAT IS ACCEPTED ───────────────────────────────────────────────────────────────
 * JPEG, PNG or WebP, recognised by the file's own first bytes rather than the content type
 * the client claims. SVG is refused: it is a document that can carry script, and this is
 * served to every visitor's browser.
 */
const ORGANIZER_ROLES = [Role.ORGANIZER_OWNER, Role.ORGANIZER_MANAGER];

/** Which picture. The rules are identical; only the size cap and the field differ. */
export type OrgImageKind = 'LOGO' | 'COVER';

/** A logo is a small square. Anything larger is a poster somebody dropped in by mistake. */
export const ORG_LOGO_MAX_BYTES = 1024 * 1024;
/** A cover is a wide banner across the top of a profile, so it is allowed to be bigger. */
export const ORG_COVER_MAX_BYTES = 3 * 1024 * 1024;

export function orgImageMaxBytes(kind: OrgImageKind): number {
  return kind === 'COVER' ? ORG_COVER_MAX_BYTES : ORG_LOGO_MAX_BYTES;
}

/** A stored picture's public path, versioned so a replacement is never served from a cache. */
export function organizationImagePath(
  organizationId: string,
  kind: OrgImageKind,
  sha256: string,
): string {
  const path = kind === 'COVER' ? 'cover' : 'logo';
  return `/public/organizers/${organizationId}/${path}?v=${sha256.slice(0, 16)}`;
}

@Injectable()
export class OrganizationImagesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly access: OrgAccessService,
    private readonly audit: AuditService,
    private readonly objects: ObjectStoreService,
  ) {}

  /**
   * Store (or replace) the logo, and point the organization's `logoUrl` at it.
   *
   * Writing `logoUrl` is what makes every existing reader work untouched: the console
   * masthead, the public organizer page and the event page all already render whatever that
   * field holds. This changes where the bytes live, not how anybody reads them.
   */
  async upload(
    user: RequestUser,
    organizationId: string,
    kind: OrgImageKind,
    file?: UploadedImageFile,
  ) {
    await this.access.assertMember(user, organizationId, ORGANIZER_ROLES);

    if (!file?.buffer?.length) {
      throw new AppException(
        ErrorCodes.VALIDATION_FAILED,
        'Choose an image to upload.',
        HttpStatus.BAD_REQUEST,
      );
    }
    const maxBytes = orgImageMaxBytes(kind);
    if (file.size > maxBytes) {
      throw new AppException(
        ErrorCodes.VALIDATION_FAILED,
        `That image is larger than ${Math.round(maxBytes / (1024 * 1024))} MB.`,
        HttpStatus.PAYLOAD_TOO_LARGE,
      );
    }
    const contentType = sniffImageType(file.buffer);
    if (!contentType) {
      /*
        Judged by the bytes, never by the upload's content type - that header is whatever
        the client says, and this endpoint serves what it stores to every visitor's browser.
      */
      throw new AppException(
        ErrorCodes.VALIDATION_FAILED,
        'Upload a JPG, PNG or WebP image.',
        HttpStatus.BAD_REQUEST,
      );
    }

    const sha256 = createHash('sha256').update(file.buffer).digest('hex');

    /*
      Written to the store before the row, and outside the transaction below, for the same
      reason as an event image: an orphaned object is a few unread kilobytes, an orphaned row
      is a broken picture on a live page. The key contains the content hash, so a retry writes
      the same object to the same key.
    */
    const storageKey =
      this.objects.driver === 'postgres'
        ? null
        : await this.objects.write({
            key: organizationImageKey({ organizationId, kind, sha256, contentType }),
            body: file.buffer,
            contentType,
          });

    const data = {
      contentType,
      // One of these two, never both - the database enforces it.
      bytes: storageKey ? null : file.buffer,
      storageKey,
      sizeBytes: file.size,
      sha256,
      uploadedByUserId: user.id,
    };

    const path = organizationImagePath(organizationId, kind, sha256);
    const organization = await this.prisma.$transaction(async (tx) => {
      await tx.organizationImage.upsert({
        where: { organizationId_kind: { organizationId, kind } },
        create: { organizationId, kind, ...data },
        update: data,
      });
      /*
        Same transaction, and writing the URL field is what makes every existing reader work
        untouched: the console masthead, the public organizer page and the event page all
        already render whatever these fields hold. A stored picture nobody points at is
        invisible; a pointer to bytes that were never written is a broken image everywhere.
      */
      return tx.organization.update({
        where: { id: organizationId },
        data: kind === 'COVER' ? { coverImageUrl: path } : { logoUrl: path },
      });
    });

    await this.audit.record({
      actorUserId: user.id,
      organizationId,
      action: kind === 'COVER' ? 'ORGANIZATION_COVER_UPDATED' : 'ORGANIZATION_LOGO_UPDATED',
      entityType: 'Organization',
      entityId: organizationId,
      metadata: { kind, contentType, sizeBytes: file.size },
    });
    return { logoUrl: organization.logoUrl, coverImageUrl: organization.coverImageUrl };
  }

  /** Remove it, and stop pointing at what is no longer there. */
  async remove(user: RequestUser, organizationId: string, kind: OrgImageKind) {
    await this.access.assertMember(user, organizationId, ORGANIZER_ROLES);
    // Read the key before the row goes, so the object can be removed after. Done after the
    // transaction commits: a bucket delete that fails must not roll back the row the user
    // asked to remove, and an object nobody points at is harmless.
    const existing = await this.prisma.organizationImage.findUnique({
      where: { organizationId_kind: { organizationId, kind } },
      select: { bytes: true, storageKey: true, contentType: true },
    });
    const organization = await this.prisma.$transaction(async (tx) => {
      await tx.organizationImage.deleteMany({ where: { organizationId, kind } });
      return tx.organization.update({
        where: { id: organizationId },
        data: kind === 'COVER' ? { coverImageUrl: null } : { logoUrl: null },
      });
    });
    if (existing) await this.objects.remove(existing).catch(() => undefined);
    await this.audit.record({
      actorUserId: user.id,
      organizationId,
      action: kind === 'COVER' ? 'ORGANIZATION_COVER_REMOVED' : 'ORGANIZATION_LOGO_REMOVED',
      entityType: 'Organization',
      entityId: organizationId,
    });
    return { logoUrl: organization.logoUrl, coverImageUrl: organization.coverImageUrl };
  }

  /**
   * The picture, from wherever it is, for the public endpoint that serves it.
   *
   * `redirectTo` is set only when the object is in a public bucket with a reachable CDN
   * address; otherwise the API serves the bytes exactly as it always has. The ROW decides,
   * not the configuration, because during a backfill both answers are live at once.
   */
  async read(organizationId: string, kind: OrgImageKind) {
    const row = await this.prisma.organizationImage.findUnique({
      where: { organizationId_kind: { organizationId, kind } },
      select: { bytes: true, storageKey: true, contentType: true, sha256: true },
    });
    if (!row) return null;

    const redirectTo = this.objects.publicUrl(row);
    if (redirectTo) return { redirectTo, contentType: row.contentType, sha256: row.sha256 };

    const object = await this.objects.read(row);
    if (!object) return null;
    return { bytes: object.body, contentType: row.contentType, sha256: row.sha256 };
  }
}
