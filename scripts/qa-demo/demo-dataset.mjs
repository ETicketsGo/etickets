/**
 * The QA demo dataset: what the seed creates, where, and with which picture.
 *
 * Everything here is fictional. Titles are written to read like a real listing, because the
 * point of the set is to see how real-looking content sits in the cards and pages; what marks
 * an item as test data is its description (see DEMO_MARKER), not a suffix that would wreck the
 * very layout being looked at.
 *
 * Venues and the cinema are EXISTING QA rows, found by name. Nothing here creates a venue,
 * a cinema, a screen or a seat layout. No cinema in Telangana is used, and US events are
 * either free or priced in the venue's own currency exactly as any organizer would set them -
 * whether USD can actually be paid for is the platform's existing rule, untouched here.
 *
 * Times are wall-clock at the venue (`tz`), turned into instants by the seed.
 */

/** The first words of every demo description and synopsis. How a person tells it is test data. */
export const DEMO_MARKER = 'QA demo content - not a real event.';

/** The line that makes an item findable again on the next run. Never changes for an item. */
export const demoKeyLine = (key) => `Demo key: qa-demo/${key}`;

export const ORGANIZATION_NAME = 'Bengaluru Live';

export const VENUES = {
  blr: { name: 'Phoenix Arena', tz: 'Asia/Kolkata' },
  bom: { name: 'NSCI Dome', tz: 'Asia/Kolkata' },
  vja: { name: 'ETG Vijayawada Multiplex (QA pilot)', tz: 'Asia/Kolkata' },
  riverbend: { name: 'Riverbend Concert House', tz: 'America/Boise' },
  oldMill: { name: 'Old Mill Theater', tz: 'America/Boise' },
};

/** Andhra Pradesh. Its regulated ceilings (150 / 200 / 250) are what the layout already charges. */
export const CINEMA = { name: 'ETG Vijayawada Multiplex (QA pilot)', screen: 'Screen 1' };

/**
 * @typedef {{ name: string, priceMinor: number, quantityTotal: number, maxPerOrder?: number }} Ticket
 * @typedef {{
 *   key: string, title: string, category: string, venue: keyof typeof VENUES,
 *   date: string, time: string, hours: number, isFree?: boolean, ageLimit?: number,
 *   artists?: { name: string, role?: string }[], about: string, tickets: Ticket[], images: string[]
 * }} DemoEvent
 */

/** @type {DemoEvent[]} */
export const EVENTS = [
  {
    key: 'blr-monsoon-frequencies',
    title: 'Monsoon Frequencies Live',
    category: 'Music',
    venue: 'blr',
    date: '2026-11-14',
    time: '18:30',
    hours: 4,
    artists: [{ name: 'The Kaveri Collective', role: 'Headliner' }],
    about:
      'An evening of indie rock and electronic sets under a full light show. Doors open one hour before the first set. Standing only in the Fan Pit.',
    tickets: [
      { name: 'General', priceMinor: 79900, quantityTotal: 600, maxPerOrder: 8 },
      { name: 'Fan Pit', priceMinor: 149900, quantityTotal: 150, maxPerOrder: 4 },
    ],
    images: ['concert-yellow-stage', 'concert-red-dome'],
  },
  {
    // The soonest demo event on purpose: the organizer dashboard shows the next three
    // upcoming events, so one demo item has to be among them for its cards to be judged.
    key: 'blr-acoustic-evening',
    title: 'Acoustic Evening at the Arena',
    category: 'Music',
    venue: 'blr',
    date: '2026-10-16',
    time: '19:00',
    hours: 3,
    about:
      'A seated acoustic set by two local duos, with a short interval. Doors open 45 minutes before the start.',
    tickets: [{ name: 'Seated', priceMinor: 49900, quantityTotal: 250 }],
    images: ['concert-red-dome'],
  },
  {
    key: 'bom-indie-unplugged',
    title: 'Indie Unplugged: Rooftop Sessions',
    category: 'Music',
    venue: 'bom',
    date: '2026-11-21',
    time: '19:00',
    hours: 3,
    about:
      'Three songwriters, one acoustic stage and a short break between sets. Seating is first come, first served.',
    tickets: [{ name: 'General', priceMinor: 59900, quantityTotal: 300 }],
    images: ['guitarist-teal-spotlight'],
  },
  {
    key: 'blr-late-night-laughs',
    title: 'Late Night Laughs: Open Mic Comedy',
    category: 'Comedy',
    venue: 'blr',
    date: '2026-10-30',
    time: '20:00',
    hours: 2,
    ageLimit: 18,
    about:
      'Ten new comics, five minutes each, and a headline set to close. Some jokes are for adults only.',
    tickets: [
      { name: 'Standard', priceMinor: 39900, quantityTotal: 200 },
      { name: 'Front Row', priceMinor: 69900, quantityTotal: 40, maxPerOrder: 4 },
    ],
    images: ['microphone-warm-bokeh'],
  },
  {
    key: 'blr-product-builders',
    title: 'Product Builders Summit 2026',
    category: 'Conference',
    venue: 'blr',
    date: '2026-11-28',
    time: '09:30',
    hours: 8,
    about:
      'A one-day conference for product managers, designers and engineers. Talks in the morning, hands-on breakout rooms after lunch. Lunch and tea are included.',
    tickets: [
      { name: 'Delegate', priceMinor: 249900, quantityTotal: 400, maxPerOrder: 5 },
      { name: 'Student', priceMinor: 99900, quantityTotal: 100, maxPerOrder: 1 },
    ],
    images: ['presenter-flipchart', 'whiteboard-office'],
  },
  {
    key: 'bom-web-dev-bootcamp',
    title: 'Build Your First Web App: Weekend Bootcamp',
    category: 'Workshop',
    venue: 'bom',
    date: '2026-11-07',
    time: '10:00',
    hours: 6,
    about:
      'A beginner workshop. Bring a laptop; we set up the tools together and you leave with a working web page online. No coding experience needed.',
    tickets: [{ name: 'Workshop seat', priceMinor: 129900, quantityTotal: 60, maxPerOrder: 2 }],
    images: ['coding-laptop-red'],
  },
  {
    key: 'blr-pottery-weekend',
    title: 'Hands on Clay: Pottery Wheel Basics',
    category: 'Workshop',
    venue: 'blr',
    date: '2026-11-08',
    time: '11:00',
    hours: 3,
    about:
      'Learn to centre clay and throw a simple bowl on the wheel. All materials and aprons are provided. Your piece is fired and ready to collect two weeks later.',
    tickets: [{ name: 'Wheel spot', priceMinor: 180000, quantityTotal: 24, maxPerOrder: 2 }],
    images: ['pottery-wheel-hands'],
  },
  {
    // Deliberately WITHOUT an image: the branded placeholder must still look right next to
    // real photography, so the dataset keeps one event that shows it.
    key: 'vja-film-appreciation',
    title: 'Film Appreciation Morning',
    category: 'Community',
    venue: 'vja',
    date: '2026-11-15',
    time: '10:00',
    hours: 3,
    isFree: true,
    about:
      'A free morning talk on how films are shot and cut, with short clips and an open question time. Registration is required because seats are limited.',
    tickets: [{ name: 'Free pass', priceMinor: 0, quantityTotal: 80, maxPerOrder: 2 }],
    images: [],
  },
  {
    key: 'bom-colour-run',
    title: 'Colour Run Community Morning',
    category: 'Community',
    venue: 'bom',
    date: '2026-12-05',
    time: '07:00',
    hours: 4,
    isFree: true,
    about:
      'A 5 km fun run with colour stations every kilometre. Walkers welcome. Wear clothes you do not mind getting colourful.',
    tickets: [{ name: 'Free entry', priceMinor: 0, quantityTotal: 500, maxPerOrder: 4 }],
    images: ['colour-festival-crowd'],
  },
  {
    key: 'blr-farmers-market',
    title: 'Sunday Farmers Market',
    category: 'Food & Drink',
    venue: 'blr',
    date: '2026-11-22',
    time: '08:00',
    hours: 5,
    isFree: true,
    about:
      'Local growers, bakers and street food stalls in one place. Free entry; bring a bag for your vegetables.',
    tickets: [{ name: 'Free entry', priceMinor: 0, quantityTotal: 1000, maxPerOrder: 6 }],
    images: ['market-vegetables', 'market-grill'],
  },
  {
    key: 'bom-night-10k',
    title: 'Midnight City 10K',
    category: 'Sports',
    venue: 'bom',
    date: '2026-12-12',
    time: '20:00',
    hours: 3,
    about:
      'A timed 10 km night run that finishes on the stadium track. Every finisher gets a medal. Bib collection opens two hours before the start.',
    tickets: [{ name: 'Runner', priceMinor: 89900, quantityTotal: 800, maxPerOrder: 4 }],
    images: ['stadium-night-panorama', 'runners-street'],
  },
  {
    key: 'bom-football-final',
    title: 'City Football League Final',
    category: 'Sports',
    venue: 'bom',
    date: '2026-11-29',
    time: '18:00',
    hours: 3,
    about:
      'The two best club sides of the season meet in the final. Gates open 90 minutes before kick-off.',
    tickets: [
      { name: 'Stand', priceMinor: 34900, quantityTotal: 1500 },
      { name: 'Pavilion', priceMinor: 79900, quantityTotal: 300 },
    ],
    images: ['football-stadium-floodlit', 'stadium-crowd-panorama'],
  },
  {
    key: 'boi-riverbend-jazz',
    title: 'Riverbend Jazz Night',
    category: 'Music',
    venue: 'riverbend',
    date: '2026-11-13',
    time: '19:30',
    hours: 3,
    about:
      'A quartet and a brass trio across two sets, with a short break. Table seating at the front, open seating at the back.',
    tickets: [
      { name: 'Open seating', priceMinor: 2800, quantityTotal: 250 },
      { name: 'Table for two', priceMinor: 7500, quantityTotal: 30, maxPerOrder: 2 },
    ],
    images: ['saxophone-player', 'brass-band'],
  },
  {
    key: 'boi-old-mill-comedy',
    title: 'Old Mill Stand-up Showcase',
    category: 'Comedy',
    venue: 'oldMill',
    date: '2026-11-20',
    time: '20:00',
    hours: 2,
    ageLimit: 18,
    about: 'Five touring comedians, one night only. Adult language throughout.',
    tickets: [{ name: 'General', priceMinor: 2200, quantityTotal: 180 }],
    images: ['microphone-purple-bokeh'],
  },
  {
    key: 'boi-vinyl-night',
    title: 'Vinyl Listening Night',
    category: 'Community',
    venue: 'riverbend',
    date: '2026-12-04',
    time: '18:00',
    hours: 3,
    isFree: true,
    about:
      'Bring one record you love and tell us why. We play a side of each and talk between tracks. Free; please register so we can plan seating.',
    tickets: [{ name: 'Free pass', priceMinor: 0, quantityTotal: 60, maxPerOrder: 2 }],
    images: ['record-player'],
  },
];

/**
 * @typedef {{
 *   key: string, title: string, language: string, certificate: string, runtimeMinutes: number,
 *   genres: string[], about: string, poster: string, shows: { date: string, time: string }[]
 * }} DemoMovie
 */

/** Fictional films. The posters are abstract photographs, never real film artwork. */
/** @type {DemoMovie[]} */
export const MOVIES = [
  {
    key: 'film-kaveri-stars',
    title: 'Beyond the Kaveri Stars',
    language: 'Telugu',
    certificate: 'UA',
    runtimeMinutes: 138,
    genres: ['Drama', 'Adventure'],
    about:
      'A night-sky photographer walks the length of a river to find the place her father mapped forty years ago.',
    poster: 'poster-night-sky-torch',
    shows: [
      { date: '2026-11-05', time: '10:00' },
      { date: '2026-11-12', time: '10:00' },
      { date: '2026-11-19', time: '10:00' },
    ],
  },
  {
    key: 'film-saltwater-lines',
    title: 'Saltwater Lines',
    language: 'English',
    certificate: 'U',
    runtimeMinutes: 112,
    genres: ['Documentary'],
    about: 'Fishing families on one stretch of coast, through one monsoon season.',
    poster: 'poster-ocean-swirl',
    shows: [
      { date: '2026-11-05', time: '14:00' },
      { date: '2026-11-12', time: '14:00' },
      { date: '2026-11-19', time: '14:00' },
    ],
  },
  {
    key: 'film-monsoon-canvas',
    title: 'Monsoon Canvas',
    language: 'Hindi',
    certificate: 'U',
    runtimeMinutes: 124,
    genres: ['Drama', 'Romance'],
    about: 'Two painters share a studio for one rainy summer and cannot agree on a single colour.',
    poster: 'poster-abstract-paint',
    shows: [
      { date: '2026-11-05', time: '18:30' },
      { date: '2026-11-12', time: '18:30' },
      { date: '2026-11-19', time: '18:30' },
    ],
  },
];
