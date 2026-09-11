import { HttpStatus, Injectable } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { EventStatus, Role } from '@eticketsgo/shared-types';
import { PrismaService } from '../prisma/prisma.service';
import { OrgAccessService } from '../tenancy/org-access.service';
import { AuditService } from '../audit/audit.service';
import { AppException, ErrorCodes } from '../common/errors';
import type { RequestUser } from '../common/decorators';
import { EVENT_IMAGE_MAX_BYTES, eventImagePath, sniffImageType } from './event-image';

/** The part of a multer file this service reads. Declared here so the API needs no multer types. */
export interface UploadedImageFile {
  buffer: Buffer;
  size: number;
  mimetype?: string;
  originalname?: string;
}

/**
 * Who may change an event's image, and when.
 *
 * The same rule as every other edit to an event: an organizer owner or manager, while the event
 * is a draft, under review, or paused. A published event's content is what an admin approved,
 * so changing its picture goes through the same pause as changing its title.
 */
const EDITABLE: EventStatus[] = [EventStatus.DRAFT, EventStatus.UNDER_REVIEW, EventStatus.PAUSED];
const ORGANIZER_ROLES = [Role.ORGANIZER_OWNER, Role.ORGANIZER_MANAGER];

@Injectable()
export class EventImageService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly access: OrgAccessService,
    private readonly audit: AuditService,
  ) {}

  async put(user: RequestUser, eventId: string, file: UploadedImageFile | undefined) {
    const event = await this.editableEvent(user, eventId);
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
    const data = {
      contentType,
      bytes: file.buffer,
      sizeBytes: file.buffer.length,
      sha256,
      uploadedByUserId: user.id,
    };
    await this.prisma.eventImage.upsert({
      where: { eventId },
      create: { eventId, ...data },
      update: data,
    });
    await this.audit.record({
      actorUserId: user.id,
      organizationId: event.organizationId,
      action: 'EVENT_IMAGE_UPDATED',
      entityType: 'Event',
      entityId: eventId,
      metadata: { contentType, sizeBytes: file.buffer.length },
    });
    return { imagePath: eventImagePath(eventId, sha256) };
  }

  async remove(user: RequestUser, eventId: string) {
    const event = await this.editableEvent(user, eventId);
    const { count } = await this.prisma.eventImage.deleteMany({ where: { eventId } });
    if (count > 0) {
      await this.audit.record({
        actorUserId: user.id,
        organizationId: event.organizationId,
        action: 'EVENT_IMAGE_REMOVED',
        entityType: 'Event',
        entityId: eventId,
      });
    }
    return { ok: true };
  }

  /** The bytes, for the public image route. The only reader of them. */
  read(eventId: string) {
    return this.prisma.eventImage.findUnique({
      where: { eventId },
      select: { bytes: true, contentType: true, sha256: true },
    });
  }

  private async editableEvent(user: RequestUser, eventId: string) {
    const event = await this.prisma.event.findUnique({
      where: { id: eventId },
      select: { id: true, organizationId: true, status: true },
    });
    if (!event) {
      throw new AppException(ErrorCodes.NOT_FOUND, 'Event not found.', HttpStatus.NOT_FOUND);
    }
    await this.access.assertMember(user, event.organizationId, ORGANIZER_ROLES);
    if (!EDITABLE.includes(event.status as EventStatus)) {
      throw new AppException(
        ErrorCodes.CONFLICT,
        `An event in status ${event.status} cannot be edited. Pause it first to change its image.`,
        HttpStatus.CONFLICT,
      );
    }
    return event;
  }
}
