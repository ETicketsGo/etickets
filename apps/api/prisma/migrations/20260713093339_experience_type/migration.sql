-- CreateEnum
CREATE TYPE "ExperienceType" AS ENUM ('EVENT', 'MOVIE', 'MUSEUM', 'THEME_PARK', 'ATTRACTION', 'TOUR');

-- AlterTable
ALTER TABLE "Event" ADD COLUMN     "experienceType" "ExperienceType" NOT NULL DEFAULT 'EVENT';
