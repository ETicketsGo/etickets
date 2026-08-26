-- CreateTable
CREATE TABLE "AdminGrant" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "permission" TEXT NOT NULL,
    "grantedByUserId" TEXT,
    "note" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AdminGrant_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "AdminGrant_userId_idx" ON "AdminGrant"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "AdminGrant_userId_permission_key" ON "AdminGrant"("userId", "permission");

-- AddForeignKey
ALTER TABLE "AdminGrant" ADD CONSTRAINT "AdminGrant_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AdminGrant" ADD CONSTRAINT "AdminGrant_grantedByUserId_fkey" FOREIGN KEY ("grantedByUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

