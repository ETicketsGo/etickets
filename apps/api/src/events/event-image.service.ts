import { HttpStatus, Injectable } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { EventStatus, Role } from '@eticketsgo/shared-types';
import { PrismaService } from '../prisma/prisma.service';
import { OrgAccessService } from '../tenancy/org-access.service';
import { AuditService } from '../audit/audit.service';
import { AppException, ErrorCodes } from '../common/errors';
import type { RequestUser } from '../common/decorators';
import {
  EVENT_IMAGE_MAX_BYTES,
  EVENT_IMAGE_MAX_COUNT,
  coverImagePath,
  eventImageOrder,
  eventImagePath,
  sniffImageType,
} from './event-image';

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

@Injectable()
export class EventImageService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly access: OrgAccessService,
    private readonly audit: AuditService,
  ) {}

  /** Adds one image at the end of the event's images. The first image ever added is the cover. */
  async add(user: RequestUser, eventId: string, file: UploadedImageFile | undefined) {
    const event = await this.changeableEvent(user, eventId);
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
    const sha256 = createHash('sha256').update(file.buffer).digest('hex');

    /*
      The count and the new position are read and written together, so two uploads landing at
      once cannot both see nine images and make twelve, or both take the same position.
    */
    const created = await this.prisma.$transaction(async (tx) => {
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
          bytes: file.buffer,
          sizeBytes: file.buffer.length,
          sha256,
          uploadedByUserId: user.id,
        },
        select: { id: true },
      });
    });

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

  /** The event's images in order, as the organizer console shows them. Never the bytes. */
  async gallery(eventId: string) {
    const rows = await this.prisma.eventImage.findMany({
      where: { eventId },
      orderBy: eventImageOrder(),
      select: { id: true, sha256: true, contentType: true, sizeBytes: true },
    });
    return {
      imagePath: coverImagePath(eventId, rows),
      images: rows.map((row) => ({
        id: row.id,
        path: eventImagePath(eventId, row.id, row.sha256),
        contentType: row.contentType,
        sizeBytes: row.sizeBytes,
      })),
    };
  }

  /** One image's bytes, for the public image route. Scoped to its event. */
  read(eventId: string, imageId: string) {
    return this.prisma.eventImage.findFirst({
      where: { id: imageId, eventId },
      select: { bytes: true, contentType: true, sha256: true },
    });
  }

  /** The cover's bytes — for links issued before an event could hold more than one image. */
  readCover(eventId: string) {
    return this.prisma.eventImage.findFirst({
      where: { eventId },
      orderBy: eventImageOrder(),
      select: { bytes: true, contentType: true, sha256: true },
    });
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
