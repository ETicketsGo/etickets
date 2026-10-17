-- H5: bind an offline check-in manifest to the device it was issued to. Additive and nullable:
-- rows written before this change keep NULL, which no device can cite as proof.
ALTER TABLE "CheckInManifest" ADD COLUMN "deviceId" TEXT;
CREATE INDEX "CheckInManifest_deviceId_idx" ON "CheckInManifest"("deviceId");
