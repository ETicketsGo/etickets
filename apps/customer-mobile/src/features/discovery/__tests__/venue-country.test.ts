import { venueSchema } from '../schema';
import { eventDetailSchema } from '@/features/events/schema';
import { publicShowSchema } from '@/features/cinema/movie-schema';

/**
 * Venue.country is nullable in the API (Prisma `country String?`), and an organizer's
 * venue outside a launch market has none. Each of these schemas required it, so one such
 * venue failed the parse of the whole discovery list, event page or showtime list.
 */
describe('a venue with no country', () => {
  it.each([
    ['discovery card', venueSchema],
    ['event page', eventDetailSchema.shape.venue],
    ['showtime', publicShowSchema.shape.venue],
  ])('still parses on the %s', (_label, schema) => {
    const venue = { id: 'v1', name: 'Hall', city: 'Pune', country: null, address: null };
    expect(schema.safeParse(venue).success).toBe(true);
  });
});
