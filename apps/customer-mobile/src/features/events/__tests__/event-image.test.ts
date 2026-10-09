import { discoverySchema, eventPageSchema } from '@/features/discovery/schema';
import { eventDetailSchema } from '../schema';
import { eventImageUrl } from '../event-image';

/**
 * An event's picture, from the API's response to the URL the app loads.
 *
 * The app showed no event pictures at all: the API sent `imagePath` and `imageVariants`, and
 * the schemas did not name them, so Zod dropped them on arrival. These pin that the fields
 * now survive the parse, that an older API without them still parses, and which copy each
 * place in the app loads.
 */

const API = 'https://api.example.test/api';

// The shape the API sends since event pictures had copies, as /public/events returns it.
const variants = {
  thumb: '/public/events/ev_1/images/img_1/thumb?v=abc',
  'card-sm': '/public/events/ev_1/images/img_1/card-sm?v=abc',
  card: '/public/events/ev_1/images/img_1/card?v=abc',
  'banner-sm': '/public/events/ev_1/images/img_1/banner-sm?v=abc',
  banner: '/public/events/ev_1/images/img_1/banner?v=abc',
  full: '/public/events/ev_1/images/img_1/full?v=abc',
};

const card = {
  id: 'ev_1',
  title: 'Standup Night',
  slug: 'standup-night',
  category: 'Comedy',
  venue: { name: 'Phoenix Arena', city: 'Bengaluru', country: 'India' },
  organizer: 'Bengaluru Live',
  nextSessionAt: '2026-08-15T20:42:17.541Z',
  fromPriceMinor: 79900,
  currency: 'INR',
};

const page = (event: Record<string, unknown>) =>
  eventPageSchema.parse({
    data: [event],
    meta: { page: 1, pageSize: 20, total: 1, totalPages: 1 },
  }).data[0];

describe('event picture fields', () => {
  it('keeps the picture on an event card', () => {
    const parsed = page({
      ...card,
      imagePath: '/public/events/ev_1/images/img_1',
      imageVariants: variants,
    });
    expect(parsed.imagePath).toBe('/public/events/ev_1/images/img_1');
    expect(parsed.imageVariants?.card).toBe(variants.card);
  });

  it('keeps the picture on every discovery shelf', () => {
    const parsed = discoverySchema.parse({
      nowShowing: [],
      trendingEvents: [{ ...card, imagePath: null, imageVariants: variants }],
      thisWeekend: [{ ...card, imagePath: null, imageVariants: variants }],
      categories: [],
    });
    expect(parsed.trendingEvents[0].imageVariants?.banner).toBe(variants.banner);
    expect(parsed.thisWeekend[0].imageVariants?.thumb).toBe(variants.thumb);
  });

  it('keeps the picture on the event page', () => {
    const parsed = eventDetailSchema.parse({
      id: 'ev_1',
      title: 'Standup Night',
      slug: 'standup-night',
      experienceType: 'EVENT',
      category: 'Comedy',
      description: null,
      refundPolicy: null,
      feeMode: 'CUSTOMER_PAYS',
      venue: {
        id: 'v1',
        name: 'Phoenix Arena',
        city: 'Bengaluru',
        country: 'India',
        address: null,
      },
      organizer: { id: 'o1', name: 'Bengaluru Live' },
      sessions: [],
      imagePath: '/public/events/ev_1/images/img_1',
      imageVariants: variants,
    });
    expect(parsed.imageVariants?.banner).toBe(variants.banner);
  });

  it('still parses an older API that sends neither field', () => {
    const parsed = page(card);
    expect(parsed.imagePath).toBeUndefined();
    expect(parsed.imageVariants).toBeUndefined();
  });

  it('reads an event with no picture as no picture', () => {
    const parsed = page({ ...card, imagePath: null, imageVariants: null });
    expect(eventImageUrl(parsed, 'card', API)).toBeNull();
  });

  it('treats a picture of the wrong shape as none, instead of failing the whole shelf', () => {
    const parsed = page({ ...card, imagePath: 42, imageVariants: 'card.webp' });
    expect(parsed.title).toBe('Standup Night');
    expect(parsed.imagePath).toBeNull();
    expect(parsed.imageVariants).toBeNull();
  });
});

describe('eventImageUrl', () => {
  const event = { imagePath: '/public/events/ev_1/images/img_1', imageVariants: variants };

  it('loads the large copy cut for each place, joined to the API base', () => {
    expect(eventImageUrl(event, 'card', API)).toBe(`${API}${variants.card}`);
    expect(eventImageUrl(event, 'banner', API)).toBe(`${API}${variants.banner}`);
    expect(eventImageUrl(event, 'thumb', API)).toBe(`${API}${variants.thumb}`);
  });

  it('falls back to the smaller copy when the larger one is missing', () => {
    const { card: _card, banner: _banner, ...rest } = variants;
    expect(eventImageUrl({ imageVariants: rest }, 'card', API)).toBe(
      `${API}${variants['card-sm']}`,
    );
    expect(eventImageUrl({ imageVariants: rest }, 'banner', API)).toBe(
      `${API}${variants['banner-sm']}`,
    );
  });

  it('falls back to the original upload when there are no copies', () => {
    expect(eventImageUrl({ imagePath: event.imagePath, imageVariants: null }, 'card', API)).toBe(
      `${API}/public/events/ev_1/images/img_1`,
    );
  });

  it('joins without doubling or losing the slash', () => {
    expect(eventImageUrl({ imagePath: '/a' }, 'card', `${API}/`)).toBe(`${API}/a`);
    expect(eventImageUrl({ imagePath: 'a' }, 'card', API)).toBe(`${API}/a`);
  });

  it('leaves an absolute URL alone', () => {
    expect(eventImageUrl({ imagePath: 'https://cdn.example.test/p.webp' }, 'card', API)).toBe(
      'https://cdn.example.test/p.webp',
    );
  });
});
