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
      'From drafting your event to opening the gate, here is a calm, ordered way to launch your first on-sale without surprises.',
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
        text: 'Your first event on a new platform should feel boring — in the best way. Here is a checklist that keeps it that way.',
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
        text: 'Watch your sales dashboard, keep an eye on conversion, and have a coupon ready for a launch push if you need one.',
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
    title: 'Selling more tickets without discounting yourself to zero',
    excerpt:
      'Discounts are a tool, not a strategy. Here is how to use coupons, timing, and clarity to sell more while protecting your margin.',
    category: 'Growth',
    tags: ['organizers', 'promotions'],
    author: 'The ETicketsGo Team',
    role: 'Growth',
    date: '2026-07-06',
    readingMinutes: 5,
    body: [
      {
        type: 'p',
        text: 'The fastest way to erode your event economics is a permanent discount. The second fastest is a confusing checkout.',
      },
      { type: 'h2', text: 'Use coupons with intent' },
      {
        type: 'ul',
        items: [
          'Time-box codes with a start and end date',
          'Cap redemptions so scarcity is real',
          'Reserve deeper discounts for genuine partners',
        ],
      },
      { type: 'h2', text: 'Reduce friction, not price' },
      {
        type: 'p',
        text: 'Show the full total early, keep the flow short, and make seat selection obvious. Clarity converts as well as any coupon.',
      },
    ],
  },
  {
    slug: 'improving-attendee-experience',
    title: 'Five small things that make attendees love your event',
    excerpt:
      'The details attendees remember are rarely the big ones. A few small touches make the difference between fine and fantastic.',
    category: 'Experience',
    tags: ['attendees', 'experience'],
    author: 'The ETicketsGo Team',
    role: 'Design',
    date: '2026-07-02',
    readingMinutes: 4,
    body: [
      {
        type: 'p',
        text: 'Attendees judge your event long before the first act — and long after the last.',
      },
      {
        type: 'ul',
        items: [
          'A booking flow that shows the total up front',
          'Tickets that open offline at the gate',
          'A bright, awake screen in Event Day Mode',
          'Fast, respectful entry',
          'Simple refunds when plans change',
        ],
      },
      {
        type: 'p',
        text: 'None of these are flashy. All of them build trust — and trust is what brings people back.',
      },
    ],
  },
  {
    slug: 'offline-ticket-validation',
    title: 'Offline ticket validation, explained simply',
    excerpt:
      'What actually happens when you scan a ticket with no internet — and why it stays trustworthy.',
    category: 'Engineering',
    tags: ['offline', 'security'],
    author: 'The ETicketsGo Team',
    role: 'Engineering',
    date: '2026-06-28',
    readingMinutes: 7,
    body: [
      {
        type: 'p',
        text: 'Venue networks fail. A ticketing platform that stops working when the Wi-Fi does is not really a ticketing platform.',
      },
      { type: 'h2', text: 'A signed manifest, not a guess' },
      {
        type: 'p',
        text: 'Approved devices download a cryptographically-signed manifest scoped to the device. The device holds no signing secret — it validates scans against the manifest.',
      },
      { type: 'h2', text: 'The server always wins' },
      {
        type: 'p',
        text: 'Scans queue durably and reconcile when you reconnect. A rejected scan can never become an admission, and duplicates resolve to a single accepted entry.',
      },
    ],
  },
  {
    slug: 'modern-ticketing-platforms',
    title: 'What a modern ticketing platform should actually do',
    excerpt:
      'Ticketing is not just a checkout. Here is the short list of what separates a real platform from a payment form.',
    category: 'Perspective',
    tags: ['platform', 'perspective'],
    author: 'The ETicketsGo Team',
    role: 'Product',
    date: '2026-06-20',
    readingMinutes: 5,
    body: [
      {
        type: 'p',
        text: 'Anyone can take a payment. A platform earns the name by handling everything around it.',
      },
      {
        type: 'ul',
        items: [
          'Race-safe inventory and reserved seating',
          'Money you can reconcile to the cent',
          'Entry that works with or without a network',
          'Analytics that explain what sold and why',
          'Fairness to buyers, built in',
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
