-- Mobile push device registry.
--
-- Separate from "PushSubscription" (Web Push: endpoint + p256dh/auth). A native token is
-- a single opaque string with a different lifecycle, and merging the two would leave
-- half of every row null.
--
-- The unique index on "token" is the deduplication mechanism: re-registering the same
-- device updates one row, and a token that moves to another account is reassigned to
-- that account rather than duplicated across both.
CREATE TABLE "UserDevice" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "token" TEXT NOT NULL,
    "provider" TEXT NOT NULL DEFAULT 'expo',
    "platform" TEXT NOT NULL,
    "appVersion" TEXT,
    "locale" TEXT,
    "timezone" TEXT,
    "permissionStatus" TEXT NOT NULL DEFAULT 'undetermined',
    "disabled" BOOLEAN NOT NULL DEFAULT false,
    "lastSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "UserDevice_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "UserDevice_token_key" ON "UserDevice"("token");
CREATE INDEX "UserDevice_userId_idx" ON "UserDevice"("userId");
CREATE INDEX "UserDevice_userId_disabled_idx" ON "UserDevice"("userId", "disabled");

-- Cascade: a deleted user's devices go with them. Account deletion also removes them
-- explicitly inside its transaction, so revocation does not depend on this alone.
ALTER TABLE "UserDevice" ADD CONSTRAINT "UserDevice_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
