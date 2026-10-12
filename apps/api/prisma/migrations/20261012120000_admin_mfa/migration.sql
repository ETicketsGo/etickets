-- Admin MFA (TOTP). Forward-only and additive: four NEW tables, no existing column is changed,
-- dropped or rewritten, and no row is inserted. Rolling the API back leaves these tables unused.
--
-- Nothing here enrolls anybody or locks anybody out: with MFA_ENCRYPTION_KEY unset the feature is
-- dormant, and once it is set each administrator is asked to enroll at their next sign-in.

CREATE TABLE "AdminMfaCredential" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "secretCiphertext" TEXT NOT NULL,
    "confirmedAt" TIMESTAMP(3),
    "lastUsedStep" INTEGER NOT NULL DEFAULT 0,
    "failedAttempts" INTEGER NOT NULL DEFAULT 0,
    "lockedUntil" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AdminMfaCredential_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "AdminMfaRecoveryCode" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "codeHash" TEXT NOT NULL,
    "usedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AdminMfaRecoveryCode_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "RefreshTokenMfa" (
    "refreshTokenId" TEXT NOT NULL,
    "credentialId" TEXT NOT NULL,
    "verifiedAt" TIMESTAMP(3) NOT NULL,
    "method" TEXT NOT NULL,

    CONSTRAINT "RefreshTokenMfa_pkey" PRIMARY KEY ("refreshTokenId")
);

CREATE TABLE "AdminMfaBreakGlassUse" (
    "id" TEXT NOT NULL,
    "nonceHash" TEXT NOT NULL,
    "userId" TEXT,
    "usedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AdminMfaBreakGlassUse_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "AdminMfaCredential_userId_key" ON "AdminMfaCredential"("userId");
CREATE INDEX "AdminMfaRecoveryCode_userId_idx" ON "AdminMfaRecoveryCode"("userId");
CREATE UNIQUE INDEX "AdminMfaBreakGlassUse_nonceHash_key" ON "AdminMfaBreakGlassUse"("nonceHash");

ALTER TABLE "AdminMfaCredential" ADD CONSTRAINT "AdminMfaCredential_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "AdminMfaRecoveryCode" ADD CONSTRAINT "AdminMfaRecoveryCode_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "RefreshTokenMfa" ADD CONSTRAINT "RefreshTokenMfa_refreshTokenId_fkey" FOREIGN KEY ("refreshTokenId") REFERENCES "RefreshToken"("id") ON DELETE CASCADE ON UPDATE CASCADE;
