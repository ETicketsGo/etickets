import { HttpStatus, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import * as bcrypt from 'bcryptjs';
import { createHash, randomBytes } from 'node:crypto';
import type { AuthTokens } from '@eticketsgo/shared-types';
import { Role } from '@eticketsgo/shared-types';
import type { LoginInput, RegisterInput } from '@eticketsgo/validation';
import { PrismaService } from '../prisma/prisma.service';
import { AppException, ErrorCodes } from '../common/errors';
import { AuditService } from '../audit/audit.service';
import type { AccessTokenPayload } from './jwt.strategy';

interface RequestMeta {
  userAgent?: string;
  ip?: string;
}

@Injectable()
export class AuthService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly jwt: JwtService,
    private readonly config: ConfigService,
    private readonly audit: AuditService,
  ) {}

  async register(input: RegisterInput, meta: RequestMeta): Promise<AuthTokens> {
    const existing = await this.prisma.user.findUnique({ where: { email: input.email } });
    if (existing) {
      throw new AppException(
        ErrorCodes.EMAIL_ALREADY_REGISTERED,
        'An account with this email already exists.',
        HttpStatus.CONFLICT,
      );
    }
    const passwordHash = await bcrypt.hash(input.password, 12);
    const user = await this.prisma.user.create({
      data: {
        email: input.email,
        passwordHash,
        fullName: input.fullName,
        roles: [Role.CUSTOMER],
      },
    });
    return this.issueTokens(user.id, user.email, user.fullName, user.roles as Role[], meta);
  }

  async login(input: LoginInput, meta: RequestMeta): Promise<AuthTokens> {
    const user = await this.prisma.user.findUnique({ where: { email: input.email } });
    if (!user || !(await bcrypt.compare(input.password, user.passwordHash))) {
      // Forensic trail for credential-stuffing / brute-force (audit is fail-safe).
      await this.audit.record({
        actorUserId: user?.id ?? null,
        action: 'AUTH_LOGIN_FAILED',
        entityType: 'User',
        entityId: user?.id ?? null,
        metadata: { email: input.email, reason: user ? 'bad_password' : 'unknown_user' },
        ip: meta.ip ?? null,
      });
      throw new AppException(
        ErrorCodes.INVALID_CREDENTIALS,
        'Incorrect email or password.',
        HttpStatus.UNAUTHORIZED,
      );
    }
    await this.audit.record({
      actorUserId: user.id,
      action: 'AUTH_LOGIN',
      entityType: 'User',
      entityId: user.id,
      ip: meta.ip ?? null,
    });
    return this.issueTokens(user.id, user.email, user.fullName, user.roles as Role[], meta);
  }

  async refresh(refreshToken: string, meta: RequestMeta): Promise<AuthTokens> {
    const tokenHash = this.hashToken(refreshToken);
    const record = await this.prisma.refreshToken.findUnique({ where: { tokenHash } });
    if (!record || record.expiresAt < new Date()) {
      throw new AppException(
        ErrorCodes.INVALID_REFRESH_TOKEN,
        'Your session has expired. Please sign in again.',
        HttpStatus.UNAUTHORIZED,
      );
    }
    // Reuse detection: a recognized-but-already-revoked token is a token that was
    // already rotated (or explicitly logged out). Presenting it again is a replay
    // and a compromise signal — the same secret is now in two places. Treat the
    // whole family as burned: revoke every still-active refresh token for the user
    // (forcing a fresh sign-in everywhere), then reject.
    if (record.revokedAt) {
      await this.prisma.refreshToken.updateMany({
        where: { userId: record.userId, revokedAt: null },
        data: { revokedAt: new Date() },
      });
      // Replay of a rotated/revoked token = compromise signal; record the family burn.
      await this.audit.record({
        actorUserId: record.userId,
        action: 'AUTH_TOKEN_REUSE_DETECTED',
        entityType: 'RefreshToken',
        entityId: record.id,
        metadata: { familyRevoked: true },
        ip: meta.ip ?? null,
      });
      throw new AppException(
        ErrorCodes.INVALID_REFRESH_TOKEN,
        'Your session has expired. Please sign in again.',
        HttpStatus.UNAUTHORIZED,
      );
    }
    const user = await this.prisma.user.findUnique({ where: { id: record.userId } });
    if (!user) {
      throw new AppException(
        ErrorCodes.INVALID_REFRESH_TOKEN,
        'Session invalid.',
        HttpStatus.UNAUTHORIZED,
      );
    }

    // Rotate: revoke the used token, then issue a fresh pair.
    const tokens = await this.issueTokens(
      user.id,
      user.email,
      user.fullName,
      user.roles as Role[],
      meta,
    );
    const replacement = await this.prisma.refreshToken.findUnique({
      where: { tokenHash: this.hashToken(tokens.refreshToken) },
    });
    await this.prisma.refreshToken.update({
      where: { id: record.id },
      data: { revokedAt: new Date(), replacedByTokenId: replacement?.id },
    });
    return tokens;
  }

  async logout(refreshToken: string): Promise<void> {
    const tokenHash = this.hashToken(refreshToken);
    await this.prisma.refreshToken
      .updateMany({ where: { tokenHash, revokedAt: null }, data: { revokedAt: new Date() } })
      .catch(() => undefined);
  }

  /**
   * Retention/hygiene sweep: delete refresh tokens that are safely dead — expired
   * past a grace period, or revoked more than `graceDays` ago. Keeps the PII-bearing
   * (ip/userAgent) table bounded and drops data past any lawful basis. Idempotent.
   */
  async pruneExpiredRefreshTokens(now: Date = new Date(), graceDays = 7): Promise<number> {
    const cutoff = new Date(now.getTime() - graceDays * 24 * 60 * 60 * 1000);
    const { count } = await this.prisma.refreshToken.deleteMany({
      where: {
        OR: [{ expiresAt: { lt: cutoff } }, { revokedAt: { lt: cutoff } }],
      },
    });
    return count;
  }

  private async issueTokens(
    userId: string,
    email: string,
    fullName: string,
    roles: Role[],
    meta: RequestMeta,
  ): Promise<AuthTokens> {
    const payload: AccessTokenPayload = { sub: userId, email, name: fullName, roles };
    const accessToken = await this.jwt.signAsync(payload, {
      secret: this.config.getOrThrow<string>('JWT_ACCESS_SECRET'),
      expiresIn: this.config.get<string>('JWT_ACCESS_TTL', '900s'),
    });

    const refreshToken = randomBytes(48).toString('hex');
    const ttlDays = parseTtlDays(this.config.get<string>('JWT_REFRESH_TTL', '30d'));
    const expiresAt = new Date(Date.now() + ttlDays * 24 * 60 * 60 * 1000);
    await this.prisma.refreshToken.create({
      data: {
        userId,
        tokenHash: this.hashToken(refreshToken),
        expiresAt,
        userAgent: meta.userAgent,
        ip: meta.ip,
      },
    });

    return { accessToken, refreshToken };
  }

  private hashToken(token: string): string {
    return createHash('sha256').update(token).digest('hex');
  }
}

function parseTtlDays(ttl: string): number {
  const match = /^(\d+)\s*d$/.exec(ttl.trim());
  return match ? Number(match[1]) : 30;
}
