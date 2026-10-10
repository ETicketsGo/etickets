import { HttpStatus, Injectable, Logger } from '@nestjs/common';
import { createHash } from 'node:crypto';
import {
  EventStatus,
  Role,
  normaliseFocalPoint,
  type EventImageVariantName,
  type FocalPoint,
} from '@eticketsgo/shared-types';
import { PrismaService } from '../prisma/prisma.service';
import { OrgAccessService } from '../tenancy/org-access.service';
import { AuditService } from '../audit/audit.service';
import { AppException, ErrorCodes } from '../common/errors';
import { ObjectStoreService } from '../storage/object-store.service';
import { eventImageKey } from '../storage/object-keys';
import type { RequestUser } from '../common/decorators';
import { isUniqueViolation } from './request-key';
import {
  EVENT_IMAGE_MAX_BYTES,
  EVENT_IMAGE_MAX_COUNT,
  EVENT_IMAGE_URL_SELECT,
  coverImagePath,
  coverImageVariants,
  eventImageOrder,
  eventImageVariantsVersion,
  eventImagesView,
  focalPointOf,
  sniffImageType,
} from './event-image';
import {
  EventImageRejected,
  renderEventImage,
  type RenderedEventImageVariant,
} from './event-image-processing';

/** The part of a multer file this service reads. Declared here so the API needs no multer types. */
export interface UploadedImageFile {
  buffer: Buffer;
  size: number;
  mimetype?: string;
  originalname?: string;
}

/**
 * When an event's images can change.
 *
 * ── ANY TIME THE EVENT IS STILL SELLING, INCLUDING WHILE PUBLISHED ───────────────────
 * Images first followed the rule for text edits — draft, under review or paused — so adding a
 * poster to a live event meant pausing sales to do it. The owner's call: a picture is not the
 * contract a buyer relies on the way a title, date or refund rule is, and pausing a live event
 * to change one costs real sales. Every change is audited.
 *
 * An event that is over — cancelled, completed or archived — is a record, and its images are
 * part of what it looked like when people bought.
 */
const LOCKED: EventStatus[] = [EventStatus.CANCELLED, EventStatus.COMPLETED, EventStatus.ARCHIVED];
const ORGANIZER_ROLES = [Role.ORGANIZER_OWNER, Role.ORGANIZER_MANAGER];

/** An image as the public routes hand it to `sendEventImage`. */
export interface ServedEventImage {
  bytes?: Uint8Array;
  redirectTo?: string;
  contentType: string;
  sha256: string;
  /** The URL version this answer is good for; the original's hash prefix when absent. */
  version?: string;
}

@Injectable()
export class EventImageService {
  private readonly logger = new Logger(EventImageService.name);
  /**
   * Copies being cut right now for images uploaded before copies existed, by image id.
   *
   * A browse page asks for every card at once, and a popular event's card is asked for by many
   * browsers at once. Without this each request would decode the same original and cut the same
   * six copies; with it they all wait for the one that is already doing it.
   */
  private readonly backfilling = new Map<string, Promise<void>>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly access: OrgAccessService,
    private readonly audit: AuditService,
    private readonly objects: ObjectStoreService,
  ) {}

  /**
   * Adds one image at the end of the event's images. The first image ever added is the cover.
   *
   * ── ONE IMAGE PER KEY ──────────────────────────────────────────────────────────────
   * The console uploads an event's images after creating it, and a browser can lose the
   * response to an upload that did arrive: the tab reloaded, the connection dropped. Retrying
   * that file must not put the picture on the event twice. With an `idempotencyKey` (one per
   * file the organizer picked), a repeat answers with the gallery as it is. The key is claimed
   * inside the transaction that writes the image row, so a key exists exactly when its image
   * does: an upload that failed half way leaves the key free for the retry, and two copies of
   * one request racing end with one image. Without a key nothing changes.
   */
  async add(
    user: RequestUser,
    eventId: string,
    file: UploadedImageFile | undefined,
    idempotencyKey?: string,
  ) {
    const event = await this.changeableEvent(user, eventId);
    const keyed = idempotencyKey ? { scope: `event-image:${eventId}`, key: idempotencyKey } : null;
    // Already done: answered before the file is decoded and cut again for nothing.
    if (keyed && (await this.keyUsed(keyed))) return this.gallery(eventId);
    if (!file?.buffer?.length) {
      throw new AppException(
        ErrorCodes.VALIDATION_FAILED,
        'Choose an image to upload.',
        HttpStatus.BAD_REQUEST,
      );
    }
    // Multer enforces this while reading; checked again so the rule does not live only in a decorator.
    if (file.buffer.length > EVENT_IMAGE_MAX_BYTES) {
      throw new AppException(
        ErrorCodes.VALIDATION_FAILED,
        'That image is larger than 2 MB. Choose a smaller one.',
        HttpStatus.PAYLOAD_TOO_LARGE,
      );
    }
    const contentType = sniffImageType(file.buffer);
    if (!contentType) {
      throw new AppException(
        ErrorCodes.VALIDATION_FAILED,
        'Upload a JPG, PNG or WebP image.',
        HttpStatus.UNSUPPORTED_MEDIA_TYPE,
      );
    }
    /*
      Decoded and cut BEFORE anything is stored. The signature check above only says what the
      file claims to be; this is what proves it is a picture, and a file that cannot be cut into
      a card is a file that would have been a broken card.
    */
    const rendered = await this.render(file.buffer, normaliseFocalPoint(null, null));
    const sha256 = createHash('sha256').update(file.buffer).digest('hex');
    const variantRows = await this.storeVariants(eventId, rendered);

    /*
      The object goes to the store BEFORE the row is written, and deliberately outside the
      transaction below.

      An orphaned object costs a few kilobytes nobody ever reads; an orphaned ROW is a broken
      image on a live event page. The key is the content's own hash, so a retry writes the same
      object to the same key and the waste is bounded at one copy however many times this runs.
    */
    const stored =
      this.objects.driver === 'postgres'
        ? null
        : await this.objects.write({
            key: eventImageKey({ eventId, sha256, contentType }),
            body: file.buffer,
            contentType,
          });

    /*
      The count and the new position are read and written together, so two uploads landing at
      once cannot both see nine images and make twelve, or both take the same position.
    */
    let created: { id: string };
    try {
      created = await this.prisma.$transaction(async (tx) => {
        // First, so a repeat stops here - before the count, which a repeat must not trip.
        if (keyed) await tx.idempotencyRecord.create({ data: { ...keyed, status: 'COMPLETED' } });
        const existing = await tx.eventImage.findMany({
          where: { eventId },
          select: { position: true },
        });
        if (existing.length >= EVENT_IMAGE_MAX_COUNT) {
          throw new AppException(
            ErrorCodes.CONFLICT,
            `An event can have up to ${EVENT_IMAGE_MAX_COUNT} images. Remove one to add another.`,
            HttpStatus.CONFLICT,
          );
        }
        const position = existing.reduce((next, row) => Math.max(next, row.position + 1), 0);
        return tx.eventImage.create({
          data: {
            eventId,
            position,
            contentType,
            // One of these two, never both - the database enforces it. `stored` is null while
            // the driver is the database, which is what every environment runs by default.
            bytes: stored ? null : file.buffer,
            storageKey: stored,
            sizeBytes: file.buffer.length,
            sha256,
            uploadedByUserId: user.id,
            // In the same statement as the image, so there is never an image whose copies are
            // half written: it has all of them or, if this fails, it does not exist.
            variants: { create: variantRows },
          },
          select: { id: true },
        });
      });
    } catch (err) {
      // The same file under the same key, committed first by an earlier copy of this request.
      if (keyed && isUniqueViolation(err) && (await this.keyUsed(keyed))) {
        return this.gallery(eventId);
      }
      throw err;
    }

    await this.audit.record({
      actorUserId: user.id,
      organizationId: event.organizationId,
      action: 'EVENT_IMAGE_ADDED',
      entityType: 'Event',
      entityId: eventId,
      metadata: { imageId: created.id, contentType, sizeBytes: file.buffer.length },
    });
    return this.gallery(eventId);
  }

  private async keyUsed(keyed: { scope: string; key: string }): Promise<boolean> {
    const record = await this.prisma.idempotencyRecord.findUnique({
      where: { scope_key: keyed },
      select: { id: true },
    });
    return record !== null;
  }

  async remove(user: RequestUser, eventId: string, imageId: string) {
    const event = await this.changeableEvent(user, eventId);
    // Scoped to the event, so an image id from another organization's event removes nothing.
    const { count } = await this.prisma.eventImage.deleteMany({ where: { id: imageId, eventId } });
    if (count === 0) {
      throw new AppException(
        ErrorCodes.NOT_FOUND,
        'That image is not on this event.',
        HttpStatus.NOT_FOUND,
      );
    }
    await this.audit.record({
      actorUserId: user.id,
      organizationId: event.organizationId,
      action: 'EVENT_IMAGE_REMOVED',
      entityType: 'Event',
      entityId: eventId,
      metadata: { imageId },
    });
    return this.gallery(eventId);
  }

  /**
   * Puts the event's images in the order given; the first becomes the cover.
   *
   * The whole list, not a single move: a client sending "move image 3 up" while another
   * organizer's upload lands would apply its move to a list that has changed underneath it.
   * Naming every image exactly once means a stale order is refused instead of half-applied.
   */
  async reorder(user: RequestUser, eventId: string, imageIds: string[]) {
    const event = await this.changeableEvent(user, eventId);
    const rows = await this.prisma.eventImage.findMany({
      where: { eventId },
      select: { id: true },
    });
    const current = new Set(rows.map((row) => row.id));
    const exact =
      imageIds.length === rows.length &&
      new Set(imageIds).size === imageIds.length &&
      imageIds.every((id) => current.has(id));
    if (!exact) {
      throw new AppException(
        ErrorCodes.VALIDATION_FAILED,
        'The images on this event have changed. Reload and try again.',
        HttpStatus.CONFLICT,
      );
    }
    await this.prisma.$transaction(
      imageIds.map((id, position) =>
        this.prisma.eventImage.update({ where: { id }, data: { position } }),
      ),
    );
    await this.audit.record({
      actorUserId: user.id,
      organizationId: event.organizationId,
      action: 'EVENT_IMAGES_REORDERED',
      entityType: 'Event',
      entityId: eventId,
      metadata: { coverImageId: imageIds[0] ?? null },
    });
    return this.gallery(eventId);
  }

  /**
   * Chooses the part of an image every crop keeps in view, and cuts its copies again.
   *
   * The copies are cut from the ORIGINAL every time, never from a previous copy, so moving the
   * point back and forth loses nothing. The point and the copies are written in one
   * transaction, and the image row is written first so it is locked for the rest of it: two
   * organizers clicking at once end with the point and the copies of whichever saved last,
   * never the point of one and the copies of the other.
   */
  async setFocalPoint(user: RequestUser, eventId: string, imageId: string, point: FocalPoint) {
    const event = await this.changeableEvent(user, eventId);
    const row = await this.prisma.eventImage.findFirst({
      where: { id: imageId, eventId },
      select: { id: true, bytes: true, storageKey: true, contentType: true },
    });
    if (!row) {
      throw new AppException(
        ErrorCodes.NOT_FOUND,
        'That image is not on this event.',
        HttpStatus.NOT_FOUND,
      );
    }
    const original = await this.objects.read(row);
    if (!original) {
      throw new AppException(
        ErrorCodes.NOT_FOUND,
        'That image could not be found. Remove it and upload it again.',
        HttpStatus.NOT_FOUND,
      );
    }
    const focal = normaliseFocalPoint(point.x, point.y);
    const rendered = await this.render(original.body, focal);
    const variantRows = await this.storeVariants(eventId, rendered);
    await this.prisma.$transaction(async (tx) => {
      await tx.eventImage.update({
        where: { id: imageId },
        data: { focalX: focal.x, focalY: focal.y },
      });
      await tx.eventImageVariant.deleteMany({ where: { imageId } });
      await tx.eventImageVariant.createMany({
        data: variantRows.map((variant) => ({ ...variant, imageId })),
      });
    });
    await this.audit.record({
      actorUserId: user.id,
      organizationId: event.organizationId,
      action: 'EVENT_IMAGE_FOCAL_POINT_SET',
      entityType: 'Event',
      entityId: eventId,
      metadata: { imageId, focalX: focal.x, focalY: focal.y },
    });
    return this.gallery(eventId);
  }

  /** The event's images in order, as the organizer console shows them. Never the bytes. */
  async gallery(eventId: string) {
    const rows = await this.prisma.eventImage.findMany({
      where: { eventId },
      orderBy: eventImageOrder(),
      select: { ...EVENT_IMAGE_URL_SELECT, contentType: true, sizeBytes: true },
    });
    return {
      imagePath: coverImagePath(eventId, rows),
      imageVariants: coverImageVariants(eventId, rows),
      images: eventImagesView(eventId, rows).map((view, i) => ({
        ...view,
        contentType: rows[i].contentType,
        sizeBytes: rows[i].sizeBytes,
      })),
    };
  }

  /**
   * One image, for the public image route. Scoped to its event.
   *
   * The link names the ORIGINAL, but what it serves is the whole picture made upright and
   * stripped of the camera's metadata - the `full` copy - when there is one. A phone photo can
   * carry the place it was taken, and this URL is on every public page that predates the
   * copies. Same picture, same version: `full` is made from these exact bytes and nothing else.
   */
  read(eventId: string, imageId: string) {
    return this.resolve({ id: imageId, eventId });
  }

  /** The cover — for links issued before an event could hold more than one image. */
  readCover(eventId: string) {
    return this.resolve({ eventId }, eventImageOrder());
  }

  /**
   * One web-ready copy of an image.
   *
   * An image uploaded before copies existed has none yet. Its copies are cut the first time one
   * is asked for and kept, so the old catalogue becomes fast without anyone re-uploading
   * anything. If they cannot be cut, the original is served instead under a short cache: a
   * card showing the picture uncropped is better than a card showing nothing.
   */
  async readVariant(
    eventId: string,
    imageId: string,
    name: EventImageVariantName,
  ): Promise<ServedEventImage | null> {
    const image = await this.prisma.eventImage.findFirst({
      where: { id: imageId, eventId },
      select: { id: true, sha256: true, focalX: true, focalY: true },
    });
    if (!image) return null;
    let variant = await this.variantRow(imageId, name);
    if (!variant) {
      await this.backfill(eventId, imageId);
      variant = await this.variantRow(imageId, name);
    }
    const served = variant ? await this.serve(variant, image.sha256) : null;
    if (!served) return this.read(eventId, imageId);
    return { ...served, version: eventImageVariantsVersion(image.sha256, focalPointOf(image)) };
  }

  private variantRow(imageId: string, name: string) {
    return this.prisma.eventImageVariant.findUnique({
      where: { imageId_name: { imageId, name } },
      select: { bytes: true, storageKey: true, contentType: true },
    });
  }

  /** Cuts and keeps the copies of an image that has none. Never throws: the caller falls back. */
  private backfill(eventId: string, imageId: string): Promise<void> {
    const running = this.backfilling.get(imageId);
    if (running) return running;
    const work = (async () => {
      try {
        const row = await this.prisma.eventImage.findFirst({
          where: { id: imageId, eventId },
          select: { bytes: true, storageKey: true, contentType: true, focalX: true, focalY: true },
        });
        if (!row) return;
        const original = await this.objects.read(row);
        if (!original) return;
        const rendered = await renderEventImage(original.body, focalPointOf(row));
        const variantRows = await this.storeVariants(eventId, rendered);
        /*
          `skipDuplicates`: another instance may have cut the same copies a moment ago, or the
          organizer may have moved the focal point while this ran. Either way the copies already
          there are at least as right as these, so these are dropped rather than written over.
        */
        await this.prisma.eventImageVariant.createMany({
          data: variantRows.map((variant) => ({ ...variant, imageId })),
          skipDuplicates: true,
        });
      } catch (err) {
        this.logger.warn(
          `Could not make copies of event image ${imageId}; serving the original. ${String(err)}`,
        );
      } finally {
        this.backfilling.delete(imageId);
      }
    })();
    this.backfilling.set(imageId, work);
    return work;
  }

  /** The copies, or the organizer's reason why not. */
  private async render(buffer: Buffer, focal: FocalPoint) {
    try {
      return await renderEventImage(buffer, focal);
    } catch (err) {
      if (!(err instanceof EventImageRejected)) throw err;
      const tooBig = err.reason === 'too-many-pixels';
      throw new AppException(
        ErrorCodes.VALIDATION_FAILED,
        tooBig
          ? 'That image has too many pixels. Use one under 25 megapixels, such as 6000 x 4000.'
          : 'That file could not be read as an image. Upload a JPG, PNG or WebP image.',
        tooBig ? HttpStatus.PAYLOAD_TOO_LARGE : HttpStatus.UNSUPPORTED_MEDIA_TYPE,
      );
    }
  }

  /**
   * Each copy as the row that records it: its bytes in the row while the store is the
   * database, or written to the store first and named by key, exactly as the original is.
   */
  private async storeVariants(
    eventId: string,
    rendered: { variants: RenderedEventImageVariant[] },
  ) {
    return Promise.all(
      rendered.variants.map(async (variant) => {
        const stored =
          this.objects.driver === 'postgres'
            ? null
            : await this.objects.write({
                key: eventImageKey({
                  eventId,
                  sha256: variant.sha256,
                  contentType: variant.contentType,
                }),
                body: variant.bytes,
                contentType: variant.contentType,
              });
        return {
          name: variant.name,
          contentType: variant.contentType,
          width: variant.width,
          height: variant.height,
          bytes: stored ? null : variant.bytes,
          storageKey: stored,
          sizeBytes: variant.bytes.length,
          sha256: variant.sha256,
        };
      }),
    );
  }

  /**
   * An image's bytes, from wherever they are, or the address a browser should fetch instead.
   *
   * ── WHY THE ROW DECIDES AND NOT THE CONFIGURATION ──────────────────────────────────
   * During a backfill both answers are live at once: a poster uploaded last week has its bytes
   * in this database and one uploaded after the switch has a key into the bucket. Asking the
   * configuration which to use would be wrong for half the rows on any day the backfill is
   * still running, which is every day for a while.
   *
   * `redirectTo` is set only when the object is in a public bucket AND a reachable base URL is
   * configured. Until then the API serves the bytes exactly as it always has, which is correct
   * and merely slower - so switching the driver on never has to wait for a custom domain.
   */
  private async resolve(
    where: { id?: string; eventId: string },
    orderBy?: ReturnType<typeof eventImageOrder>,
  ): Promise<ServedEventImage | null> {
    const row = await this.prisma.eventImage.findFirst({
      where,
      ...(orderBy ? { orderBy } : {}),
      select: {
        bytes: true,
        storageKey: true,
        contentType: true,
        sha256: true,
        variants: {
          where: { name: 'full' },
          select: { bytes: true, storageKey: true, contentType: true },
        },
      },
    });
    if (!row) return null;
    // Versioned by the ORIGINAL's hash either way: `full` is a function of those bytes alone.
    const full = row.variants?.[0];
    if (full) {
      const served = await this.serve(full, row.sha256);
      if (served) return served;
    }
    return this.serve(row, row.sha256);
  }

  /** One stored object as a public answer: a redirect to the bucket, or its bytes. */
  private async serve(
    row: { bytes: Uint8Array | null; storageKey: string | null; contentType: string },
    sha256: string,
  ): Promise<ServedEventImage | null> {
    const redirectTo = this.objects.publicUrl(row);
    if (redirectTo) return { redirectTo, contentType: row.contentType, sha256 };

    const object = await this.objects.read(row);
    // A row pointing at an object the store does not have is data loss, and the caller turns
    // it into a 404. A placeholder here would hide that behind a grey rectangle.
    if (!object) return null;
    return { bytes: object.body, contentType: row.contentType, sha256 };
  }

  private async changeableEvent(user: RequestUser, eventId: string) {
    const event = await this.prisma.event.findUnique({
      where: { id: eventId },
      select: { id: true, organizationId: true, status: true },
    });
    if (!event) {
      throw new AppException(ErrorCodes.NOT_FOUND, 'Event not found.', HttpStatus.NOT_FOUND);
    }
    await this.access.assertMember(user, event.organizationId, ORGANIZER_ROLES);
    if (LOCKED.includes(event.status as EventStatus)) {
      throw new AppException(
        ErrorCodes.CONFLICT,
        `This event is ${event.status.toLowerCase()}, so its images can no longer be changed.`,
        HttpStatus.CONFLICT,
      );
    }
    return event;
  }
}
