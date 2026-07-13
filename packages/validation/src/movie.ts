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
