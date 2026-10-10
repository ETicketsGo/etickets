import { HttpStatus } from '@nestjs/common';
import { AppException, ErrorCodes } from '../common/errors';

/**
 * The `Idempotency-Key` an organizer's console sends with a create, checked for shape.
 *
 * ── WHY CREATES IN THE CONSOLE NEED ONE ────────────────────────────────────────────
 * A POST whose response is lost (a dropped connection, a tab reloaded mid-upload) has usually
 * done its work. The console cannot tell that from a request that never arrived, so the safe
 * retry is the SAME request with the SAME key, and the server answers it with what the first
 * one made instead of making it twice. Without a key the request behaves exactly as before.
 *
 * The key is the client's own random id. Short, URL-safe and bounded so nobody can park a
 * megabyte of text in the idempotency table through a header.
 */
export function requestKey(raw: string | string[] | undefined): string | undefined {
  const value = Array.isArray(raw) ? raw[0] : raw;
  if (value === undefined || value === '') return undefined;
  if (!/^[A-Za-z0-9_-]{8,128}$/.test(value)) {
    throw new AppException(
      ErrorCodes.VALIDATION_FAILED,
      'The Idempotency-Key header must be 8 to 128 letters, digits, "-" or "_".',
      HttpStatus.BAD_REQUEST,
    );
  }
  return value;
}

/** A unique-constraint violation: here, the key was already claimed by an earlier request. */
export function isUniqueViolation(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { code?: string }).code === 'P2002';
}
