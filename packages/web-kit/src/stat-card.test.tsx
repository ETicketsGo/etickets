import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { Ticket } from 'lucide-react';
import { StatCard } from './console';

/*
  The compact StatCard is the phone's two-across figure. What must hold: the same facts as the
  comfortable card (label, value, caption, link), the small tile instead of the 48px one, and
  the tight padding - and the comfortable card must be untouched for every page that uses it.
*/
describe('StatCard density', () => {
  const props = { label: 'Tickets sold', value: '51', hint: '1 checked in (2%)', icon: Ticket };

  it('keeps the comfortable card as it was by default', () => {
    const html = renderToStaticMarkup(<StatCard {...props} />);
    expect(html).toContain('p-5');
    expect(html).toContain('h-12 w-12');
    expect(html).toContain('text-[1.625rem]');
  });

  it('draws the compact card with the small tile, tight padding and every fact', () => {
    const html = renderToStaticMarkup(<StatCard {...props} density="compact" />);
    expect(html).toContain('p-3');
    expect(html).not.toContain('p-5');
    expect(html).toContain('h-8 w-8');
    expect(html).not.toContain('h-12 w-12');
    for (const text of ['Tickets sold', '51', '1 checked in (2%)']) expect(html).toContain(text);
  });

  it('is still one link to the page behind the number when compact', () => {
    const html = renderToStaticMarkup(
      <StatCard {...props} density="compact" href="/organizer/events" />,
    );
    expect(html.match(/<a /g)).toHaveLength(1);
    expect(html).toContain('href="/organizer/events"');
  });
});
