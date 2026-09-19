/**
 * Sample blog content for the marketing site. All posts are clearly marked as sample
 * content; replace this module with a CMS or MDX source when real content exists.
 * Content blocks keep the renderer simple (heading vs paragraph vs bullet list).
 */
export type Block =
  { type: 'p'; text: string } | { type: 'h2'; text: string } | { type: 'ul'; items: string[] };

export interface Post {
  slug: string;
  title: string;
  excerpt: string;
  category: string;
  tags: string[];
  author: string;
  role: string;
  date: string; // ISO
  readingMinutes: number;
  featured?: boolean;
  body: Block[];
}

export const POSTS: Post[] = [
  {
    slug: 'launching-your-first-event',
    title: 'Launching your first event: a practical checklist',
    excerpt:
      'A checklist for your first on-sale, from the first draft to the moment the gate opens.',
    category: 'Guides',
    tags: ['organizers', 'getting-started'],
    author: 'The ETicketsGo Team',
    role: 'Product',
    date: '2026-07-10',
    readingMinutes: 6,
    featured: true,
    body: [
      {
        type: 'p',
        text: 'Nothing should surprise you on your first event. Here is what to check before you go on sale.',
      },
      { type: 'h2', text: 'Before you publish' },
      {
        type: 'ul',
        items: [
          'Draft the event with clear sessions and ticket tiers',
          'Set a fee mode you are comfortable explaining to buyers',
          'Add a refund policy that matches your risk',
          'Do a test booking end to end',
        ],
      },
      { type: 'h2', text: 'During the on-sale' },
      {
        type: 'p',
        text: 'Watch your sales dashboard. Have a coupon ready in case you need to push the launch.',
      },
      { type: 'h2', text: 'At the gate' },
      {
        type: 'p',
        text: 'Prepare your devices, run the offline check-in preflight, and keep the reconciliation console open. If the network drops, you keep scanning.',
      },
    ],
  },
  {
    slug: 'selling-more-tickets',
    title: 'How to use coupons without giving away your margin',
    excerpt: 'A coupon works best with a limit and an end date. Here is how we suggest using them.',
    category: 'Growth',
    tags: ['organizers', 'promotions'],
    author: 'The ETicketsGo Team',
    role: 'Growth',
    date: '2026-07-06',
    readingMinutes: 5,
    body: [
      {
        type: 'p',
        text: 'A discount you never turn off becomes your real price. A confusing checkout costs you sales as well.',
      },
      { type: 'h2', text: 'Set limits on every code' },
      {
        type: 'ul',
        items: [
          'Time-box codes with a start and end date',
          'Cap redemptions so scarcity is real',
          'Reserve deeper discounts for genuine partners',
        ],
      },
      { type: 'h2', text: 'Make the checkout clear' },
      {
        type: 'p',
        text: 'Show the full total early and keep the steps short. Make the seat map easy to read.',
      },
    ],
  },
  {
    slug: 'improving-attendee-experience',
    title: 'Five small things attendees notice',
    excerpt:
      'Small details decide how an evening feels. Here are five that are worth getting right.',
    category: 'Experience',
    tags: ['attendees', 'experience'],
    author: 'The ETicketsGo Team',
    role: 'Design',
    date: '2026-07-02',
    readingMinutes: 4,
    body: [
      {
        type: 'p',
        text: 'People form an opinion of your event before the first act, and after the last one.',
      },
      {
        type: 'ul',
        items: [
          'A booking flow that shows the total up front',
          'Tickets that open offline at the gate',
          'A bright, awake screen in Event Day Mode',
          'A queue at the door that keeps moving',
          'Simple refunds when plans change',
        ],
      },
      {
        type: 'p',
        text: 'None of these are flashy. They are the reason people come back.',
      },
    ],
  },
  {
    slug: 'offline-ticket-validation',
    title: 'Offline ticket validation, explained simply',
    excerpt:
      'What happens when you scan a ticket with no internet, and why the result still holds.',
    category: 'Engineering',
    tags: ['offline', 'security'],
    author: 'The ETicketsGo Team',
    role: 'Engineering',
    date: '2026-06-28',
    readingMinutes: 7,
    body: [
      {
        type: 'p',
        text: 'Venue networks fail. Your gate still has to let people in.',
      },
      { type: 'h2', text: 'A signed list of tickets' },
      {
        type: 'p',
        text: 'An approved device downloads a signed list of the tickets for that event. The list only works on that device, and the device holds no signing key. It checks each scan against the list.',
      },
      { type: 'h2', text: 'The server always wins' },
      {
        type: 'p',
        text: 'Scans wait on the device and go to the server when you reconnect. A scan the device rejected can never become an admission, and two scans of one ticket end as a single entry.',
      },
    ],
  },
  {
    slug: 'modern-ticketing-platforms',
    title: 'What a modern ticketing platform should actually do',
    excerpt: 'Taking the payment is the easy part. Here is the rest of the job.',
    category: 'Perspective',
    tags: ['platform', 'perspective'],
    author: 'The ETicketsGo Team',
    role: 'Product',
    date: '2026-06-20',
    readingMinutes: 5,
    body: [
      {
        type: 'p',
        text: 'Anyone can take a payment. The work is everything around it.',
      },
      {
        type: 'ul',
        items: [
          'Seat holds that stop two people buying one seat',
          'Amounts that match your payout statement',
          'Entry that works with or without a network',
          'Reports that show what sold',
          'Every fee shown to the buyer before they pay',
        ],
      },
      { type: 'p', text: 'Get those right and the checkout takes care of itself.' },
    ],
  },
];

export const CATEGORIES = Array.from(new Set(POSTS.map((p) => p.category)));

export function getPost(slug: string): Post | undefined {
  return POSTS.find((p) => p.slug === slug);
}
export function relatedPosts(slug: string, category: string, limit = 2): Post[] {
  return POSTS.filter((p) => p.slug !== slug && p.category === category)
    .concat(POSTS.filter((p) => p.slug !== slug && p.category !== category))
    .slice(0, limit);
}
export function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString('en-IN', {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  });
}
