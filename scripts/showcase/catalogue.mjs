/**
 * The showcase catalogue: sixteen fictional listings for LOCAL screenshots only.
 *
 * Why it exists: design work was being judged against seed rows called "Test Event 1712...",
 * which made every layout look worse than it is and hid real problems (a long title, a poster
 * crop, a price in three currencies). These read like a real catalogue so a screenshot tells
 * the truth about the design.
 *
 * Everything here is invented: titles, organizers, venues and performers. Venue names are
 * neighbourhood-plus-noun on purpose, so none of them is, or implies a partnership with, a
 * real venue's brand. No real performer, film, brand or logo is named or pictured.
 *
 * Never load this onto QA, UAT or production. `load-showcase.mjs` refuses any API that is not
 * on this machine before it sends a request.
 *
 * Prices are minor units in the venue's own currency. Times are wall-clock at the venue.
 * `image` / `poster` keys name files in C:\etg-wt\showcase\images (outside the repository);
 * their photographers and licences are in C:\etg-wt\showcase\CREDITS.md.
 */

/** The last line of every description, so a person and the loader can both tell it apart. */
export const SHOWCASE_MARKER = 'Showcase listing: fictional, for design review on a local machine.';
/** The same note on QA, where the sentence "on a local machine" would be false. Still says fictional. */
export const SHOWCASE_MARKER_QA =
  'Showcase listing: fictional, for demonstration on the QA environment.';
export const showcaseKeyLine = (key) => `Showcase key: showcase/${key}`;

export const CITIES = {
  blr: {
    city: 'Bengaluru',
    state: 'Karnataka',
    country: 'IN',
    currency: 'INR',
    tz: 'Asia/Kolkata',
  },
  bom: { city: 'Mumbai', state: 'Maharashtra', country: 'IN', currency: 'INR', tz: 'Asia/Kolkata' },
  // Telangana: no cinema listing here, on purpose (Telangana cinema sales stay restricted).
  hyd: {
    city: 'Hyderabad',
    state: 'Telangana',
    country: 'IN',
    currency: 'INR',
    tz: 'Asia/Kolkata',
  },
  del: { city: 'New Delhi', state: 'Delhi', country: 'IN', currency: 'INR', tz: 'Asia/Kolkata' },
  nyc: {
    city: 'New York',
    state: 'New York',
    country: 'US',
    currency: 'USD',
    tz: 'America/New_York',
  },
  tor: { city: 'Toronto', state: 'Ontario', country: 'CA', currency: 'CAD', tz: 'America/Toronto' },
};

/** Fictional organizers. One organization each, so the event page names a believable host. */
export const ORGANIZERS = {
  monsoon: { name: 'Monsoon Sound Co.', country: 'IN' },
  makers: { name: 'Makers Table', country: 'IN' },
  tallTales: { name: 'Tall Tales Comedy', country: 'IN' },
  kalaa: { name: 'Kalaa Stage Productions', country: 'IN' },
  stride: { name: 'Stride Run Club', country: 'IN' },
  hudson: { name: 'Hudson Night Sessions', country: 'US' },
  studioNine: { name: 'Studio Nine Collective', country: 'US' },
  mapleRoom: { name: 'Maple Room Live', country: 'CA' },
  // Films are listed by the cinema, as a multiplex would list them.
  pictureHouses: { name: 'Picture House Cinemas', country: 'IN' },
  lakeshore: { name: 'Lakeshore Screening Room', country: 'CA' },
};

/** Fictional venues. `kind: 'cinema'` venues need a screen with a seat layout. */
export const VENUES = {
  ulsoor: { name: 'Ulsoor Lakeside Amphitheatre', at: 'blr', address: 'Lakeside Road, Ulsoor' },
  roastery: { name: 'The Roastery Room', at: 'blr', address: '11th Main Road, Jayanagar' },
  indiranagarPH: {
    name: 'Indiranagar Picture House',
    at: 'blr',
    address: '100 Feet Road, Indiranagar',
    kind: 'cinema',
  },
  bandraStage: { name: 'Bandra Stage Room', at: 'bom', address: 'Hill Road, Bandra West' },
  colabaPlayhouse: { name: 'Colaba Playhouse', at: 'bom', address: 'Wodehouse Road, Colaba' },
  juhuPP: {
    name: 'Juhu Picture Palace',
    at: 'bom',
    address: 'Juhu Tara Road, Juhu',
    kind: 'cinema',
  },
  banjaraAmph: {
    name: 'Banjara Hills Amphitheatre',
    at: 'hyd',
    address: 'Road No. 12, Banjara Hills',
  },
  lakePromenade: { name: 'Lakeside Promenade Start Line', at: 'hyd', address: 'Tank Bund Road' },
  jubileeStudio: {
    name: 'Jubilee Hills Craft Studio',
    at: 'hyd',
    address: 'Road No. 36, Jubilee Hills',
  },
  hauzCellar: { name: 'Hauz Khas Comedy Cellar', at: 'del', address: 'Hauz Khas Village' },
  mandiStudio: {
    name: 'Mandi House Studio Theatre',
    at: 'del',
    address: 'Copernicus Marg, Mandi House',
  },
  saketScreens: {
    name: 'Saket Screen House',
    at: 'del',
    address: 'Press Enclave Marg, Saket',
    kind: 'cinema',
  },
  atlanticLoft: {
    name: 'Atlantic Avenue Loft',
    at: 'nyc',
    address: '410 Atlantic Avenue, Brooklyn',
  },
  chelseaNine: { name: 'Chelsea Studio Nine', at: 'nyc', address: '527 West 27th Street' },
  queenWestLoft: { name: 'Queen West Theatre Loft', at: 'tor', address: '880 Queen Street West' },
  lakeshoreRoom: {
    name: 'Lakeshore Screening Room',
    at: 'tor',
    address: '235 Queens Quay West',
    kind: 'cinema',
  },
};

/**
 * @typedef {{ name: string, priceMinor: number, quantityTotal: number, maxPerOrder?: number }} Ticket
 * @typedef {{ key: string, kind: 'event', title: string, category: string, organizer: keyof typeof ORGANIZERS,
 *   venue: keyof typeof VENUES, date: string, time: string, hours: number, ageLimit?: number,
 *   artists?: { name: string, role?: string }[], about: string, tickets: Ticket[],
 *   image: string, focal?: { x: number, y: number } }} ShowcaseEvent
 * @typedef {{ key: string, kind: 'film', title: string, language: string, certificate: string,
 *   minutes: number, genres: string[], organizer: keyof typeof ORGANIZERS, venue: keyof typeof VENUES,
 *   dates: string[], times: string[], synopsis: string, prices: Ticket[], poster: string, backdrop: string }} ShowcaseFilm
 */

/** @type {ShowcaseEvent[]} */
export const EVENTS = [
  {
    key: 'blr-neon-raga',
    kind: 'event',
    title: 'Neon Raga: Live Under the Stars',
    category: 'Music',
    organizer: 'monsoon',
    venue: 'ulsoor',
    date: '2026-11-21',
    time: '18:30',
    hours: 4,
    artists: [
      { name: 'The Ulsoor Ensemble', role: 'Headliner' },
      { name: 'Meera and the Night Shift', role: 'Opening set' },
    ],
    about:
      'Classical ragas meet live electronics on an open-air stage by the lake. Two sets with a short interval. Gates open at 5:30 PM. Food stalls on site.',
    tickets: [
      { name: 'Lawn', priceMinor: 99900, quantityTotal: 1200, maxPerOrder: 8 },
      { name: 'Gold seating', priceMinor: 199900, quantityTotal: 400, maxPerOrder: 6 },
      { name: 'Front row', priceMinor: 349900, quantityTotal: 60, maxPerOrder: 4 },
    ],
    image: 'concert-stage-lights',
  },
  {
    key: 'blr-slow-coffee',
    kind: 'event',
    title: 'Slow Coffee: A Home Brewing Masterclass',
    category: 'Workshop',
    organizer: 'makers',
    venue: 'roastery',
    date: '2026-11-15',
    time: '10:30',
    hours: 3,
    about:
      'Learn pour-over, French press and South Indian filter coffee side by side. All equipment and beans are provided. Small group of 16, so everyone gets time at the bar.',
    tickets: [{ name: 'Workshop seat', priceMinor: 149900, quantityTotal: 16, maxPerOrder: 2 }],
    image: 'workshop-coffee-pour',
  },
  {
    key: 'bom-local-train',
    kind: 'event',
    title: 'Notes From the Local Train',
    category: 'Comedy',
    organizer: 'tallTales',
    venue: 'bandraStage',
    date: '2026-11-07',
    time: '20:00',
    hours: 2,
    ageLimit: 16,
    artists: [{ name: 'Rohan Pai', role: 'Stand-up' }],
    about:
      'A new hour of stand-up about commuting, landlords and the family group chat. Recorded for a special, so phones stay in pockets.',
    tickets: [
      { name: 'Standard', priceMinor: 49900, quantityTotal: 180 },
      { name: 'Front rows', priceMinor: 79900, quantityTotal: 40, maxPerOrder: 4 },
    ],
    image: 'comedy-mic-stage',
  },
  {
    key: 'bom-last-ferry',
    kind: 'event',
    title: 'The Last Ferry',
    category: 'Theatre',
    organizer: 'kalaa',
    venue: 'colabaPlayhouse',
    date: '2026-12-05',
    time: '19:30',
    hours: 2,
    artists: [{ name: 'Kalaa Repertory', role: 'Company' }],
    about:
      'Four strangers miss the last boat home and spend one long night on the jetty. A new play in English and Hindi, performed without an interval.',
    tickets: [
      { name: 'Balcony', priceMinor: 60000, quantityTotal: 120 },
      { name: 'Stalls', priceMinor: 120000, quantityTotal: 200 },
      { name: 'Premium stalls', priceMinor: 180000, quantityTotal: 60, maxPerOrder: 4 },
    ],
    image: 'theatre-stage-curtain',
  },
  {
    key: 'hyd-sufi-strings',
    kind: 'event',
    title: 'Deccan Nights: Sufi and Strings',
    category: 'Music',
    organizer: 'monsoon',
    venue: 'banjaraAmph',
    date: '2026-11-28',
    time: '19:00',
    hours: 3,
    artists: [{ name: 'The Deccan Strings Quartet', role: 'Headliner' }],
    about:
      'Qawwali and Sufi poetry set to a string quartet, in an open-air amphitheatre. Seating is on cushions near the stage and on chairs behind.',
    tickets: [
      { name: 'Chairs', priceMinor: 79900, quantityTotal: 500 },
      { name: 'Cushion seating', priceMinor: 149900, quantityTotal: 150, maxPerOrder: 4 },
    ],
    image: 'concert-strings-warm',
  },
  {
    key: 'hyd-night-10k',
    kind: 'event',
    title: 'Lakeside Night 10K',
    category: 'Sports',
    organizer: 'stride',
    venue: 'lakePromenade',
    date: '2026-12-12',
    time: '21:00',
    hours: 3,
    about:
      'A timed 10K and an untimed 5K around the lake after dark. Every runner gets a chip, a medal and a finish-line photo. Bag drop opens at 8 PM.',
    tickets: [
      { name: '10K timed', priceMinor: 89900, quantityTotal: 1500, maxPerOrder: 6 },
      { name: '5K fun run', priceMinor: 59900, quantityTotal: 1000, maxPerOrder: 6 },
    ],
    image: 'sports-night-run',
  },
  {
    key: 'hyd-block-print',
    kind: 'event',
    title: 'Block Printing for Beginners',
    category: 'Workshop',
    organizer: 'makers',
    venue: 'jubileeStudio',
    date: '2026-11-22',
    time: '11:00',
    hours: 4,
    about:
      'Carve your own wooden block and print a cotton tote and two napkins to take home. Natural dyes, aprons and lunch are included.',
    tickets: [{ name: 'Workshop seat', priceMinor: 180000, quantityTotal: 20, maxPerOrder: 2 }],
    image: 'workshop-block-print',
  },
  {
    key: 'del-overthinking',
    kind: 'event',
    title: 'Overthinking, Live',
    category: 'Comedy',
    organizer: 'tallTales',
    venue: 'hauzCellar',
    date: '2026-11-14',
    time: '21:00',
    hours: 2,
    ageLimit: 18,
    artists: [{ name: 'Ananya Sethi', role: 'Stand-up' }],
    about:
      'An hour of stand-up for anyone who has replayed a conversation at 2 AM. Strong language throughout.',
    tickets: [{ name: 'Standard', priceMinor: 69900, quantityTotal: 140, maxPerOrder: 6 }],
    image: 'comedy-club-crowd',
  },
  {
    key: 'del-daryaganj',
    kind: 'event',
    title: 'A House on Daryaganj Lane',
    category: 'Theatre',
    organizer: 'kalaa',
    venue: 'mandiStudio',
    date: '2026-12-19',
    time: '18:30',
    hours: 2,
    about:
      'Three generations of one family, one old house and the week it is sold. A Hindustani drama with English surtitles. One interval.',
    tickets: [
      { name: 'Standard', priceMinor: 50000, quantityTotal: 150 },
      { name: 'Front stalls', priceMinor: 90000, quantityTotal: 50, maxPerOrder: 4 },
    ],
    image: 'theatre-spotlight-actor',
  },
  {
    key: 'nyc-rooftop-jazz',
    kind: 'event',
    title: 'Rooftop Jazz on Atlantic',
    category: 'Music',
    organizer: 'hudson',
    venue: 'atlanticLoft',
    date: '2026-11-20',
    time: '19:30',
    hours: 3,
    ageLimit: 21,
    artists: [{ name: 'The Atlantic Trio', role: 'Headliner' }],
    about:
      'A late-autumn jazz set under heaters on a Brooklyn rooftop. Two sets, a full bar and a small food menu. ID required at the door.',
    tickets: [
      { name: 'General admission', priceMinor: 4500, quantityTotal: 160 },
      { name: 'Reserved table for two', priceMinor: 8500, quantityTotal: 20, maxPerOrder: 2 },
    ],
    image: 'concert-jazz-sax',
  },
  {
    key: 'nyc-design-crit',
    kind: 'event',
    title: 'Critique Club: A Night for Product Designers',
    category: 'Workshop',
    organizer: 'studioNine',
    venue: 'chelseaNine',
    date: '2026-11-18',
    time: '18:30',
    hours: 3,
    about:
      'Bring one screen you are stuck on. Small tables of five, a facilitator at each, and a structured critique you can use the next morning. Snacks provided.',
    tickets: [{ name: 'Seat', priceMinor: 3500, quantityTotal: 60, maxPerOrder: 2 }],
    image: 'workshop-design-table',
  },
  {
    key: 'tor-snowbound',
    kind: 'event',
    title: 'Snowbound: A Winter Comedy',
    category: 'Theatre',
    organizer: 'mapleRoom',
    venue: 'queenWestLoft',
    date: '2026-12-10',
    time: '19:30',
    hours: 2,
    about:
      'A family cottage, a blizzard and one bathroom. A new comedy in two acts, suitable for ages 12 and up.',
    tickets: [
      { name: 'General', priceMinor: 3200, quantityTotal: 180 },
      { name: 'Premium', priceMinor: 5500, quantityTotal: 40, maxPerOrder: 4 },
    ],
    image: 'theatre-audience-house',
  },
];

/** @type {ShowcaseFilm[]} */
export const FILMS = [
  {
    key: 'film-long-monsoon',
    kind: 'film',
    title: 'The Long Monsoon',
    language: 'Kannada',
    certificate: 'UA13+',
    minutes: 138,
    genres: ['Drama', 'Family'],
    organizer: 'pictureHouses',
    venue: 'indiranagarPH',
    dates: ['2026-11-13', '2026-11-14', '2026-11-15'],
    times: ['13:15', '16:40', '20:10'],
    synopsis:
      'A retired ferry pilot and his granddaughter spend one rainy season restoring a boat nobody else believes will float.',
    prices: [
      { name: 'Classic', priceMinor: 25000, quantityTotal: 0 },
      { name: 'Prime', priceMinor: 35000, quantityTotal: 0 },
      { name: 'Recliner', priceMinor: 50000, quantityTotal: 0 },
    ],
    poster: 'film-long-monsoon-poster',
    backdrop: 'film-long-monsoon-backdrop',
  },
  {
    key: 'film-saltpan',
    kind: 'film',
    title: 'Saltpan',
    language: 'Marathi',
    certificate: 'U',
    minutes: 121,
    genres: ['Drama'],
    organizer: 'pictureHouses',
    venue: 'juhuPP',
    dates: ['2026-11-13', '2026-11-14'],
    times: ['12:00', '18:30', '21:45'],
    synopsis:
      'Two sisters inherit the family salt works on the coast and must decide in one season whether to sell it or save it.',
    prices: [
      { name: 'Classic', priceMinor: 22000, quantityTotal: 0 },
      { name: 'Prime', priceMinor: 32000, quantityTotal: 0 },
    ],
    poster: 'film-saltpan-poster',
    backdrop: 'film-saltpan-backdrop',
  },
  {
    key: 'film-winter-signal',
    kind: 'film',
    title: 'Winter Signal',
    language: 'Hindi',
    certificate: 'UA16+',
    minutes: 146,
    genres: ['Thriller'],
    organizer: 'pictureHouses',
    venue: 'saketScreens',
    dates: ['2026-11-13', '2026-11-14', '2026-11-15'],
    times: ['14:30', '19:00', '22:15'],
    synopsis:
      'A railway signal operator in the hills hears a message on a line that was shut down twenty years ago.',
    prices: [
      { name: 'Classic', priceMinor: 28000, quantityTotal: 0 },
      { name: 'Prime', priceMinor: 40000, quantityTotal: 0 },
      { name: 'Recliner', priceMinor: 60000, quantityTotal: 0 },
    ],
    poster: 'film-winter-signal-poster',
    backdrop: 'film-winter-signal-backdrop',
  },
  {
    key: 'film-northern-line',
    kind: 'film',
    title: 'Northern Line',
    language: 'English',
    certificate: 'PG',
    minutes: 112,
    genres: ['Drama', 'Romance'],
    organizer: 'lakeshore',
    venue: 'lakeshoreRoom',
    dates: ['2026-11-13', '2026-11-14'],
    times: ['16:00', '19:15', '21:40'],
    synopsis:
      'Two strangers keep missing each other on the same northbound train until a snowstorm stops it for a night.',
    prices: [
      { name: 'Standard', priceMinor: 1500, quantityTotal: 0 },
      { name: 'Premium', priceMinor: 1900, quantityTotal: 0 },
    ],
    poster: 'film-northern-line-poster',
    backdrop: 'film-northern-line-backdrop',
  },
];

/**
 * Every image key the catalogue uses, with the shape and subject the photo must have.
 * `cover` = 16:9 landscape, at least 2400x1350. `poster` = 2:3 portrait, at least 1200x1800.
 */
export const IMAGE_BRIEF = {
  'concert-stage-lights': {
    shape: 'cover',
    subject: 'open-air concert, crowd silhouettes, stage lights, dusk',
  },
  'workshop-coffee-pour': { shape: 'cover', subject: 'hands doing a pour-over coffee, warm light' },
  'comedy-mic-stage': {
    shape: 'cover',
    subject: 'microphone on stand, small stage, spotlight, brick or dark backdrop',
  },
  'theatre-stage-curtain': {
    shape: 'cover',
    subject: 'theatre stage with red curtain or stage lights, no performers named',
  },
  'concert-strings-warm': { shape: 'cover', subject: 'violin or cello players, warm stage light' },
  'sports-night-run': { shape: 'cover', subject: 'runners at night or city run, motion' },
  'workshop-block-print': {
    shape: 'cover',
    subject: 'textile block printing or fabric dye, hands',
  },
  'comedy-club-crowd': { shape: 'cover', subject: 'audience laughing in a dim club' },
  'theatre-spotlight-actor': {
    shape: 'cover',
    subject: 'single performer in spotlight on a dark stage, face not prominent',
  },
  'concert-jazz-sax': { shape: 'cover', subject: 'saxophone or jazz trio, night, moody' },
  'workshop-design-table': {
    shape: 'cover',
    subject: 'people around a table with sketches and laptops',
  },
  'theatre-audience-house': {
    shape: 'cover',
    subject: 'theatre auditorium seats or audience from behind',
  },
  'film-long-monsoon-poster': {
    shape: 'poster',
    subject: 'rain, river boat or monsoon landscape (no real film art)',
  },
  'film-long-monsoon-backdrop': { shape: 'cover', subject: 'rainy river landscape, boat' },
  'film-saltpan-poster': {
    shape: 'poster',
    subject: 'salt flats or coastal salt pans, figure small in frame',
  },
  'film-saltpan-backdrop': { shape: 'cover', subject: 'salt pans or coast at golden hour' },
  'film-winter-signal-poster': {
    shape: 'poster',
    subject: 'railway signal or mountain railway in fog',
  },
  'film-winter-signal-backdrop': { shape: 'cover', subject: 'mountain railway track in mist' },
  'film-northern-line-poster': { shape: 'poster', subject: 'train window at night, snow' },
  'film-northern-line-backdrop': { shape: 'cover', subject: 'snowy train or station at night' },
};
