-- Object storage: a place for binary objects, and a way for an existing image row to say
-- that its bytes live somewhere other than this database.
--
-- Additive and reversible by design. `bytes` becomes nullable and `storageKey` arrives null,
-- so every row that exists today keeps working exactly as it does now and nothing has to be
-- migrated for the next request to succeed. The backfill moves bytes to R2 afterwards, at
-- whatever pace is comfortable, and a row it has not reached yet still reads from here.

-- One binary object, when the active driver is the database. The key is content-addressed,
-- so the same bytes always land on the same key.
CREATE TABLE "StoredObject" (
    "key"         TEXT NOT NULL,
    "bytes"       BYTEA NOT NULL,
    "contentType" TEXT NOT NULL,
    "sizeBytes"   INTEGER NOT NULL,
    "createdAt"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"   TIMESTAMP(3) NOT NULL,
    CONSTRAINT "StoredObject_pkey" PRIMARY KEY ("key")
);

-- Exactly one of `bytes` and `storageKey` holds the answer for a given row.
ALTER TABLE "EventImage" ALTER COLUMN "bytes" DROP NOT NULL;
ALTER TABLE "EventImage" ADD COLUMN "storageKey" TEXT;

ALTER TABLE "OrganizationImage" ALTER COLUMN "bytes" DROP NOT NULL;
ALTER TABLE "OrganizationImage" ADD COLUMN "storageKey" TEXT;

-- A row with neither is a row whose image has been lost, and a row with both is a row whose
-- two copies can disagree. Enforced in the database because these rows are written by an
-- upload path, a backfill and a seed, and a rule kept in one of those three is a rule.
ALTER TABLE "EventImage" ADD CONSTRAINT "EventImage_bytes_or_key"
    CHECK (("bytes" IS NOT NULL) <> ("storageKey" IS NOT NULL));

ALTER TABLE "OrganizationImage" ADD CONSTRAINT "OrganizationImage_bytes_or_key"
    CHECK (("bytes" IS NOT NULL) <> ("storageKey" IS NOT NULL));

-- Finding what still needs moving, without scanning every row's bytes.
CREATE INDEX "EventImage_storageKey_idx" ON "EventImage" ("storageKey");
CREATE INDEX "OrganizationImage_storageKey_idx" ON "OrganizationImage" ("storageKey");
