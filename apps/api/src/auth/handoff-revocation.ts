import { createHash } from 'node:crypto';
import type { PrismaService } from '../prisma/prisma.service';

/*
  Kept apart from handoff.service.ts so AuthService can revoke codes on sign-out without
  importing the service that itself depends on AuthService (a circular import leaves one of the
  two classes undefined when Nest reads the constructor types, and the app does not boot).
*/

/**
 * End every code an account still has outstanding. Called by sign-out, sign-out everywhere and
 * a password reset, so ending a session never leaves a way back in behind it.
 */
export async function revokeHandoffsForUser(
  prisma: Pick<PrismaService, 'authHandoff'>,
  userId: string,
): Promise<number> {
  const { count } = await prisma.authHandoff.updateMany({
    where: { userId, consumedAt: null, revokedAt: null },
    data: { revokedAt: new Date() },
  });
  return count;
}

export function hashCode(code: string): string {
  return createHash('sha256').update(code).digest('hex');
}
