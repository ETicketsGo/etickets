-- Password reset, which did not exist at all.
--
-- Until now the only way to obtain a working password was to register with one, or to accept
-- an invitation. Anybody who forgot theirs had no route back into their account, and support
-- had none either. That gap is also what made the old invite path so damaging: it created
-- accounts nobody could sign into, and there was no mechanism to recover them.
--
-- Separate from AccountInvitation on purpose. An invitation is issued by somebody with
-- authority and handed back to them to deliver; a reset is requested by an anonymous caller
-- about an address they merely typed, so its link may only ever leave by email.

CREATE TABLE "PasswordResetToken" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "usedAt" TIMESTAMP(3),
    "requestedIp" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PasswordResetToken_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "PasswordResetToken_tokenHash_key" ON "PasswordResetToken"("tokenHash");
CREATE INDEX "PasswordResetToken_userId_idx" ON "PasswordResetToken"("userId");

ALTER TABLE "PasswordResetToken" ADD CONSTRAINT "PasswordResetToken_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
