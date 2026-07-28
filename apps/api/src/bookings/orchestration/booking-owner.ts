import { HttpStatus, Injectable } from '@nestjs/common';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { AppException, ErrorCodes } from '../../common/errors';
import type { RequestUser } from '../../common/decorators';

/**
 * Durable, server-decided booking ownership (ADR-042 §4, P5.2A). Mirrors the
 * `BookingOwnerType` Prisma enum. The client NEVER selects the owner type — it is derived
 * from the trusted request principal (USER), a server-issued anonymous session
 * (ANONYMOUS_SESSION), or an explicit internal execution context (INTERNAL).
 */
export type BookingOwnerType = 'USER' | 'ANONYMOUS_SESSION' | 'INTERNAL';

export interface ResolvedOwner {
  ownerType: BookingOwnerType;
  /** user id (USER) · SHA-256 hash of the anonymous token (ANONYMOUS_SESSION) · service id (INTERNAL). */
  ownerId: string;
}

/** A privileged, non-customer execution context for workers/ops. Not publicly reachable. */
export interface InternalExecutionContext {
  ownerType: 'INTERNAL';
  ownerId: string;
  /** Human/audit label for who/what is acting internally. */
  actor: string;
}

const ANON_TOKEN_BYTES = 32; // 256 bits of entropy
const ANON_PREFIX = 'anon_';

/**
 * Server-issued anonymous checkout identity (ADR-042 §6). ETicketsGo has no pre-existing
 * anonymous-session scheme, so guest ownership is a dedicated opaque token: generated
 * server-side with 256 bits of entropy, transmitted via the `x-anon-session` header,
 * compared in constant time, and persisted ONLY as a SHA-256 hash (the raw token never
 * touches the database or logs). It is NOT derived from email/phone/IP/device/user-agent
 * and cannot be supplied as an arbitrary client-selected owner id — the server always
 * hashes what the client presents and matches it against the stored hash.
 */
@Injectable()
export class AnonymousSessionService {
  /** Mint a fresh opaque guest token. Returned to the client once; only its hash is stored. */
  issueToken(): string {
    return ANON_PREFIX + randomBytes(ANON_TOKEN_BYTES).toString('base64url');
  }

  isWellFormed(token: string | undefined | null): token is string {
    return typeof token === 'string' && token.startsWith(ANON_PREFIX) && token.length >= 24;
  }

  /** Stable at-rest identifier: SHA-256 of the token (never reversible to the raw token). */
  hash(token: string): string {
    return createHash('sha256').update(token).digest('hex');
  }

  /** Constant-time comparison of a presented token's hash against a stored hash. */
  matches(presentedToken: string, storedHash: string): boolean {
    const a = Buffer.from(this.hash(presentedToken), 'hex');
    const b = Buffer.from(storedHash, 'hex');
    return a.length === b.length && timingSafeEqual(a, b);
  }
}

/**
 * Resolves and validates the durable owner of a booking workflow (ADR-042 §4/§5/§7).
 * Ownership is always decided server-side; a valid booking id alone never authorizes an
 * operation. Cross-user, cross-anonymous-session, and cross-tenant access are rejected.
 */
@Injectable()
export class BookingOwnerResolver {
  constructor(private readonly anon: AnonymousSessionService) {}

  /**
   * Derive the owner for an incoming customer request. An authenticated principal always
   * wins (a logged-in user is never treated as anonymous); otherwise a well-formed
   * anonymous token identifies the guest. Neither is taken from the request body/query.
   */
  resolveForRequest(input: {
    user?: RequestUser | null;
    anonymousToken?: string | null;
  }): ResolvedOwner {
    if (input.user?.id) {
      return { ownerType: 'USER', ownerId: input.user.id };
    }
    if (this.anon.isWellFormed(input.anonymousToken)) {
      return { ownerType: 'ANONYMOUS_SESSION', ownerId: this.anon.hash(input.anonymousToken) };
    }
    throw new AppException(
      ErrorCodes.UNAUTHORIZED,
      'A sign-in or a valid guest checkout session is required for this booking.',
      HttpStatus.UNAUTHORIZED,
    );
  }

  /** Explicit privileged context for system workers — never a customer code path. */
  internal(actor: string): InternalExecutionContext {
    return { ownerType: 'INTERNAL', ownerId: `internal:${actor}`, actor };
  }

  /**
   * Validate that the request owner matches the workflow's durable owner. Admin override is
   * handled by the caller (role-checked + audited) — this enforces pure customer isolation.
   * Legacy workflows created before ownership was persisted (ownerType null) fall back to
   * the underlying BookingsService/PaymentsService owner check and are not rejected here.
   */
  assertOwner(
    workflow: { ownerType: string | null; ownerId: string | null },
    requestOwner: ResolvedOwner,
  ): void {
    if (!workflow.ownerType || !workflow.ownerId) return; // pre-ownership row: delegated check
    const sameType = workflow.ownerType === requestOwner.ownerType;
    const sameId = this.constantTimeEquals(workflow.ownerId, requestOwner.ownerId);
    if (!sameType || !sameId) {
      throw new AppException(
        ErrorCodes.FORBIDDEN,
        'You cannot access this booking.',
        HttpStatus.FORBIDDEN,
      );
    }
  }

  private constantTimeEquals(a: string, b: string): boolean {
    const ba = Buffer.from(a);
    const bb = Buffer.from(b);
    return ba.length === bb.length && timingSafeEqual(ba, bb);
  }
}
