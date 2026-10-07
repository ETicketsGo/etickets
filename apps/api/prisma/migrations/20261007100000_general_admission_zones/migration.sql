-- CreateTable
CREATE TABLE "SeatZone" (
    "id" TEXT NOT NULL,
    "seatMapId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "categoryId" TEXT,
    "capacity" INTEGER NOT NULL,
    "shape" JSONB,
    "labelX" INTEGER,
    "labelY" INTEGER,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "SeatZone_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ShowZone" (
    "id" TEXT NOT NULL,
    "eventSessionId" TEXT NOT NULL,
    "zoneId" TEXT NOT NULL,
    "capacity" INTEGER NOT NULL,
    "sold" INTEGER NOT NULL DEFAULT 0,
    "held" INTEGER NOT NULL DEFAULT 0,
    "version" INTEGER NOT NULL DEFAULT 0,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ShowZone_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "SeatZone_seatMapId_idx" ON "SeatZone"("seatMapId");

-- CreateIndex
CREATE INDEX "SeatZone_categoryId_idx" ON "SeatZone"("categoryId");

-- CreateIndex
CREATE INDEX "ShowZone_eventSessionId_idx" ON "ShowZone"("eventSessionId");

-- CreateIndex
CREATE INDEX "ShowZone_zoneId_idx" ON "ShowZone"("zoneId");

-- CreateIndex
CREATE UNIQUE INDEX "ShowZone_eventSessionId_zoneId_key" ON "ShowZone"("eventSessionId", "zoneId");

-- AddForeignKey
ALTER TABLE "SeatZone" ADD CONSTRAINT "SeatZone_seatMapId_fkey" FOREIGN KEY ("seatMapId") REFERENCES "SeatMap"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SeatZone" ADD CONSTRAINT "SeatZone_categoryId_fkey" FOREIGN KEY ("categoryId") REFERENCES "SeatCategory"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ShowZone" ADD CONSTRAINT "ShowZone_eventSessionId_fkey" FOREIGN KEY ("eventSessionId") REFERENCES "EventSession"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ShowZone" ADD CONSTRAINT "ShowZone_zoneId_fkey" FOREIGN KEY ("zoneId") REFERENCES "SeatZone"("id") ON DELETE CASCADE ON UPDATE CASCADE;
