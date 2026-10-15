import { HttpStatus, Injectable, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHash } from 'node:crypto';
import sharp from 'sharp';
import { Role } from '@eticketsgo/shared-types';
import { PrismaService } from '../prisma/prisma.service';
import { OrgAccessService } from '../tenancy/org-access.service';
import { AuditService } from '../audit/audit.service';
import { AppException, ErrorCodes } from '../common/errors';
import { ObjectStoreService } from '../storage/object-store.service';
import { PUBLIC_PREFIX } from '../storage/object-keys';
import type { RequestUser } from '../common/decorators';
import { EVENT_IMAGE_MAX_BYTES, sniffImageType } from '../events/event-image';
import { EVENT_IMAGE_MAX_PIXELS } from '../events/event-image-processing';
import type { UploadedImageFile } from '../events/event-image.service';

/** Same cap as an event image: the console already tells organizers "max 2 MB". */
export const MOVIE_POSTER_MAX_BYTES = EVENT_IMAGE_MAX_BYTES;

/** A stored poster's file name: the first 32 hex characters of its hash, as WebP. */
const POSTER_FILE = /^([0-9a-f]{32})\.webp$/;

/** Where a poster's bytes live. Content-addressed: the same picture is the same key. */
export function moviePosterKey(movieId: string, hash32: string): string {
  if (!/^[a-z0-9]+$/i.test(movieId)) throw new Error('Unsafe movie id for an object key.');
  return `${PUBLIC_PREFIX}movies/${movieId}/${hash32}.webp`;
}

/** The poster's public path under the API. Versioned by its hash, so it can be cached forever. */
export function moviePosterPath(movieId: string, hash32: string): string {
  return `/public/movies/${movieId}/poster/${hash32}.webp`;
}

/**
 * Cut an upload into the one poster the platform serves: upright, sRGB, no larger than
 * 800 x 1200, WebP, with the camera's metadata dropped.
 *
 * One copy rather than an event image's six: a poster is drawn at one shape (2:3) everywhere a
 * film appears, and the storefront's cards are small. The decoder's refusals are the event
 * image's, so a file that is not really a picture is refused the same way.
 */
export async function renderMoviePoster(input: Buffer): Promise<Buffer> {
  let width = 0;
  let height = 0;
  try {
    const meta = await sharp(input, { limitInputPixels: false }).metadata();
    width = meta.width ?? 0;
    height = meta.height ?? 0;
  } catch {
    throw unreadable();
  }
  if (!width || !height) throw unreadable();
  if (width * height > EVENT_IMAGE_MAX_PIXELS) {
    throw new AppException(
      ErrorCodes.VALIDATION_FAILED,
      'That image has too many pixels. Use one under 25 megapixels.',
      HttpStatus.BAD_REQUEST,
    );
  }
  try {
    return await sharp(input, { failOn: 'warning', limitInputPixels: EVENT_IMAGE_MAX_PIXELS })
      .rotate()
      .toColourspace('srgb')
      .resize(800, 1200, { fit: 'inside', withoutEnlargement: true })
      .webp({ quality: 85 })
      .toBuffer();
  } catch {
    throw unreadable();
  }
}

const unreadable = () =>
  new AppException(
    ErrorCodes.VALIDATION_FAILED,
    'That file could not be read as an image. Use a JPG, PNG or WebP picture.',
    HttpStatus.BAD_REQUEST,
  );

/**
 * A film's poster, uploaded from the organizer's computer.
 *
 * ── WHY ────────────────────────────────────────────────────────────────────────────
 * Found walking QA (2026-10-15): the only way to give a film a poster was a "Poster URL" text
 * field, so an organizer had to host the picture somewhere else first and paste its address.
 * Every other picture on the platform (event images, organization logos) is uploaded.
 *
 * ── NO NEW TABLE ───────────────────────────────────────────────────────────────────
 * The poster is written through the object store (Postgres or R2, whichever this deployment
 * uses) under a content-addressed key, and the film's existing `posterUrl` is pointed at the
 * API route that serves it. Every reader of `posterUrl` - storefront, app, console - keeps
 * working unchanged, and a pasted URL still works exactly as before.
 */
@Injectable()
export class MoviePosterService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly access: OrgAccessService,
    private readonly objects: ObjectStoreService,
    @Optional() private readonly audit?: AuditService,
    @Optional() private readonly config?: ConfigService,
  ) {}

  /**
   * Store an uploaded poster and make it the film's poster.
   *
   * `origin` is the API origin the request reached (scheme and host). `posterUrl` is validated
   * as an absolute URL, so the poster's address is stored absolute; the web clients re-base any
   * platform image URL onto the API they talk to (`portableImageUrl`), so a renamed host does
   * not break it. PUBLIC_API_URL, when set, wins over the request's own idea of its host.
   */
  async upload(
    user: RequestUser,
    movieId: string,
    file: UploadedImageFile | undefined,
    origin: string,
  ) {
    const movie = await this.prisma.movie.findUnique({ where: { id: movieId } });
    if (!movie) {
      throw new AppException(ErrorCodes.NOT_FOUND, 'Movie not found.', HttpStatus.NOT_FOUND);
    }
    await this.access.assertMember(user, movie.organizationId, [
      Role.ORGANIZER_OWNER,
      Role.ORGANIZER_MANAGER,
    ]);
    if (!file?.buffer?.length) {
      throw new AppException(
        ErrorCodes.VALIDATION_FAILED,
        'Choose an image to upload.',
        HttpStatus.BAD_REQUEST,
      );
    }
    if (file.size > MOVIE_POSTER_MAX_BYTES) {
      throw new AppException(
        ErrorCodes.VALIDATION_FAILED,
        'That image is larger than 2 MB. Use a smaller one.',
        HttpStatus.PAYLOAD_TOO_LARGE,
      );
    }
    // The bytes decide what the file is, never the name or the browser's claim.
    if (!sniffImageType(file.buffer)) throw unreadable();

    const body = await renderMoviePoster(file.buffer);
    const hash32 = createHash('sha256').update(body).digest('hex').slice(0, 32);
    await this.objects.write({
      key: moviePosterKey(movie.id, hash32),
      body,
      contentType: 'image/webp',
    });
    const base = (this.config?.get<string>('PUBLIC_API_URL') || origin).replace(/\/+$/, '');
    const posterUrl = `${base}/api${moviePosterPath(movie.id, hash32)}`;
    const updated = await this.prisma.movie.update({
      where: { id: movie.id },
      data: { posterUrl },
    });
    await this.audit?.record({
      actorUserId: user.id,
      organizationId: movie.organizationId,
      action: 'MOVIE_POSTER_UPLOADED',
      entityType: 'Movie',
      entityId: movie.id,
      metadata: { sizeBytes: body.length, from: movie.posterUrl ?? null },
    });
    return updated;
  }

  /**
   * A stored poster, for the public route. Null when the name is not a poster's or the store
   * does not have it; the route answers 404, which is the truth.
   */
  async read(movieId: string, file: string) {
    const m = POSTER_FILE.exec(file);
    if (!m || !/^[a-z0-9]+$/i.test(movieId)) return null;
    const row = {
      bytes: null,
      storageKey: moviePosterKey(movieId, m[1]),
      contentType: 'image/webp',
    };
    const redirectTo = this.objects.publicUrl(row);
    if (redirectTo) return { redirectTo, contentType: 'image/webp', sha256: m[1], version: m[1] };
    const object = await this.objects.read(row);
    if (!object) return null;
    return {
      bytes: new Uint8Array(object.body),
      contentType: 'image/webp',
      sha256: m[1],
      version: m[1],
    };
  }
}
