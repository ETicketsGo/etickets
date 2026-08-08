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

/**
 * Status is updatable but not settable at creation: a screen is born ACTIVE, and there is
 * no sensible reason to create one already in maintenance.
 */
export const updateScreenSchema = createScreenSchema.partial().extend({
  status: z.enum(['ACTIVE', 'MAINTENANCE', 'INACTIVE']).optional(),
  /** Recorded on the audit entry when the operational state changes. */
  statusReason: z.string().trim().min(3).max(500).optional(),
});
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

/**
 * Bulk show scheduling.
 *
 * A theater manager sets a day's grid — one film, one screen, a handful of start times —
 * and repeats it across a week. Doing that one request at a time is both slow and unsafe:
 * each request is individually valid and only the set collides, so conflicts surface one
 * failure at a time after some shows already exist.
 *
 * Times are wall-clock HH:mm applied to each date, which is how a schedule is published: a
 * 10:30 show is 10:30 every day and does not shift with the server's zone. End times are
 * derived from the movie's runtime rather than supplied, so a slot cannot disagree with the
 * film's length.
 */
export const bulkScheduleShowsSchema = z
  .object({
    screenId: z.string().cuid(),
    /** Explicit dates (YYYY-MM-DD). Mutually exclusive with `from`/`to`. */
    dates: z
      .array(z.string().regex(/^\d{4}-\d{2}-\d{2}$/))
      .max(62)
      .optional(),
    /** Inclusive date range, expanded server-side. */
    from: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/)
      .optional(),
    to: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/)
      .optional(),
    /** Daily start times as wall-clock HH:mm. */
    times: z
      .array(z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/))
      .min(1)
      .max(24),
    /**
     * Minutes to add to the film's runtime for trailers and titles, so the screen is not
     * booked back-to-back against the feature length alone.
     */
    padMinutes: z.number().int().min(0).max(120).default(20),
    /** IANA zone for interpreting the wall-clock times. Defaults to the India market. */
    timezone: z.string().min(1).max(64).default('Asia/Kolkata'),
    pricing: z
      .array(z.object({ seatCategoryId: z.string().cuid(), priceMinor: z.number().int().min(0) }))
      .optional(),
    /**
     * Preview only. Returns exactly the same decisions without writing anything, so an
     * operator can resolve conflicts before committing. Defaults to true: the safe outcome
     * for a malformed or forgotten flag is "showed you the plan", never "created 40 shows".
     */
    dryRun: z.boolean().default(true),
  })
  .refine((v) => (v.dates?.length ?? 0) > 0 || (v.from && v.to), {
    message: 'Provide either explicit dates or a from/to range.',
    path: ['dates'],
  })
  .refine((v) => !(v.dates?.length && (v.from || v.to)), {
    message: 'Provide dates or a from/to range, not both.',
    path: ['dates'],
  });
export type BulkScheduleShowsInput = z.infer<typeof bulkScheduleShowsSchema>;

/**
 * Sales control and cancellation for one show.
 *
 * A reason is required for cancellation and optional for pause/reopen. Cancelling strands
 * people who have paid, and an audit trail that cannot say why is not much of an audit
 * trail; pausing is routine and usually self-evident.
 */
export const showSalesActionSchema = z.object({
  reason: z.string().trim().min(3).max(500).optional(),
});
export type ShowSalesActionInput = z.infer<typeof showSalesActionSchema>;

export const cancelShowSchema = z.object({
  reason: z.string().trim().min(3).max(500),
});
export type CancelShowInput = z.infer<typeof cancelShowSchema>;

/**
 * Move a future show.
 *
 * Only the start time is accepted; the end is recomputed from the film's runtime, so a slot
 * can never disagree with the length of what is being shown. Screen changes are deliberately
 * absent — every issued seat identifier belongs to the current screen's layout, so moving a
 * show between screens is a cancel-and-recreate, not an edit.
 */
export const rescheduleShowSchema = z.object({
  startsAt: z.coerce.date(),
  padMinutes: z.number().int().min(0).max(120).default(20),
});
export type RescheduleShowInput = z.infer<typeof rescheduleShowSchema>;

/**
 * Copy one screen's schedule for a day onto another date and/or another screen.
 *
 * Deliberately expressed as source day → target day rather than as a list of times: the
 * operator's intent is "the same as yesterday", and re-deriving the times from what is
 * actually scheduled is both less typing and impossible to get subtly wrong.
 *
 * Target screen defaults to the source, so the common case (copy yesterday to today) needs
 * only two dates. Copying to another screen is the same operation with one more field.
 */
export const copyScheduleSchema = z.object({
  sourceScreenId: z.string().cuid(),
  /** Local calendar date on the source screen, in `timezone`. */
  sourceDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  /** Defaults to the source screen. */
  targetScreenId: z.string().cuid().optional(),
  targetDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  timezone: z.string().min(1).max(64).default('Asia/Kolkata'),
  pricing: z
    .array(z.object({ seatCategoryId: z.string().cuid(), priceMinor: z.number().int().min(0) }))
    .optional(),
  dryRun: z.boolean().default(true),
});
export type CopyScheduleInput = z.infer<typeof copyScheduleSchema>;
