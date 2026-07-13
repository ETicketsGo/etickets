import { z } from 'zod';
import { MovieStatus } from '@eticketsgo/shared-types';

export const createMovieSchema = z.object({
  title: z.string().trim().min(1).max(200),
  synopsis: z.string().trim().max(8000).optional(),
  runtimeMinutes: z.number().int().min(1).max(600),
  certificate: z.string().trim().max(10).optional(),
  language: z.string().trim().min(1).max(60),
  genres: z.array(z.string().trim().min(1).max(40)).max(10).default([]),
  releaseDate: z.coerce.date().optional(),
  posterUrl: z.string().trim().url().max(1000).optional(),
  trailerUrl: z.string().trim().url().max(1000).optional(),
  cast: z.array(z.string().trim().min(1).max(120)).max(50).default([]),
  director: z.string().trim().max(120).optional(),
});
export type CreateMovieInput = z.infer<typeof createMovieSchema>;

export const updateMovieSchema = createMovieSchema.partial();
export type UpdateMovieInput = z.infer<typeof updateMovieSchema>;

export const movieStatusSchema = z.object({
  status: z.nativeEnum(MovieStatus),
});
export type MovieStatusInput = z.infer<typeof movieStatusSchema>;

export const createCinemaSchema = z.object({
  name: z.string().trim().min(2).max(160),
  brand: z.string().trim().max(120).optional(),
  city: z.string().trim().min(1).max(120),
  address: z.string().trim().max(400).optional(),
  latitude: z.number().min(-90).max(90).optional(),
  longitude: z.number().min(-180).max(180).optional(),
  venueId: z.string().cuid().optional(),
});
export type CreateCinemaInput = z.infer<typeof createCinemaSchema>;

export const updateCinemaSchema = createCinemaSchema.partial();
export type UpdateCinemaInput = z.infer<typeof updateCinemaSchema>;

export const createScreenSchema = z.object({
  name: z.string().trim().min(1).max(120),
  screenType: z.string().trim().min(1).max(20).default('2D'),
  capacity: z.number().int().min(1).max(2000),
});
export type CreateScreenInput = z.infer<typeof createScreenSchema>;

export const updateScreenSchema = createScreenSchema.partial();
export type UpdateScreenInput = z.infer<typeof updateScreenSchema>;

/** Generate a screen's seat map from a compact section spec. Each section maps to
 *  one price category with a set of rows, each holding `seatsPerRow` seats. */
export const generateSeatMapSchema = z.object({
  name: z.string().trim().max(120).optional(),
  sections: z
    .array(
      z.object({
        name: z.string().trim().min(1).max(80),
        categoryName: z.string().trim().min(1).max(60),
        colorHex: z
          .string()
          .trim()
          .regex(/^#([0-9a-fA-F]{6})$/)
          .optional(),
        basePriceMinor: z.number().int().min(0),
        rowLabels: z.array(z.string().trim().min(1).max(4)).min(1).max(40),
        seatsPerRow: z.number().int().min(1).max(60),
      }),
    )
    .min(1)
    .max(20),
});
export type GenerateSeatMapInput = z.infer<typeof generateSeatMapSchema>;

export const scheduleShowSchema = z
  .object({
    screenId: z.string().cuid(),
    startsAt: z.coerce.date(),
    endsAt: z.coerce.date(),
    pricing: z
      .array(
        z.object({
          seatCategoryId: z.string().cuid(),
          priceMinor: z.number().int().min(0),
        }),
      )
      .optional(),
  })
  .refine((v) => v.endsAt > v.startsAt, {
    message: 'The show must end after it starts.',
    path: ['endsAt'],
  });
export type ScheduleShowInput = z.infer<typeof scheduleShowSchema>;
