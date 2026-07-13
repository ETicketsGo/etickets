-- CreateEnum
CREATE TYPE "MovieStatus" AS ENUM ('DRAFT', 'PUBLISHED', 'ARCHIVED');

-- AlterTable
ALTER TABLE "Event" ADD COLUMN     "movieId" TEXT;

-- AlterTable
ALTER TABLE "EventSession" ADD COLUMN     "screenId" TEXT;

-- CreateTable
CREATE TABLE "Movie" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "synopsis" TEXT,
    "runtimeMinutes" INTEGER NOT NULL,
    "certificate" TEXT,
    "language" TEXT NOT NULL,
    "genres" TEXT[],
    "releaseDate" TIMESTAMP(3),
    "posterUrl" TEXT,
    "trailerUrl" TEXT,
    "cast" TEXT[],
    "director" TEXT,
    "status" "MovieStatus" NOT NULL DEFAULT 'DRAFT',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Movie_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Cinema" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "venueId" TEXT,
    "name" TEXT NOT NULL,
    "brand" TEXT,
    "city" TEXT NOT NULL,
    "address" TEXT,
    "latitude" DOUBLE PRECISION,
    "longitude" DOUBLE PRECISION,
    "status" TEXT NOT NULL DEFAULT 'ACTIVE',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Cinema_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Screen" (
    "id" TEXT NOT NULL,
    "cinemaId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "screenType" TEXT NOT NULL DEFAULT '2D',
    "capacity" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Screen_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Movie_slug_key" ON "Movie"("slug");

-- CreateIndex
CREATE INDEX "Movie_organizationId_idx" ON "Movie"("organizationId");

-- CreateIndex
CREATE INDEX "Movie_status_idx" ON "Movie"("status");

-- CreateIndex
CREATE INDEX "Cinema_organizationId_idx" ON "Cinema"("organizationId");

-- CreateIndex
CREATE INDEX "Cinema_city_idx" ON "Cinema"("city");

-- CreateIndex
CREATE INDEX "Screen_cinemaId_idx" ON "Screen"("cinemaId");

-- CreateIndex
CREATE INDEX "Event_experienceType_idx" ON "Event"("experienceType");

-- CreateIndex
CREATE INDEX "Event_movieId_idx" ON "Event"("movieId");

-- CreateIndex
CREATE INDEX "EventSession_screenId_idx" ON "EventSession"("screenId");

-- AddForeignKey
ALTER TABLE "Movie" ADD CONSTRAINT "Movie_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Cinema" ADD CONSTRAINT "Cinema_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Cinema" ADD CONSTRAINT "Cinema_venueId_fkey" FOREIGN KEY ("venueId") REFERENCES "Venue"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Screen" ADD CONSTRAINT "Screen_cinemaId_fkey" FOREIGN KEY ("cinemaId") REFERENCES "Cinema"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Event" ADD CONSTRAINT "Event_movieId_fkey" FOREIGN KEY ("movieId") REFERENCES "Movie"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EventSession" ADD CONSTRAINT "EventSession_screenId_fkey" FOREIGN KEY ("screenId") REFERENCES "Screen"("id") ON DELETE SET NULL ON UPDATE CASCADE;
