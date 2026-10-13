import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { BrandStatusPill, EventArtwork, brandButtonClasses, brandChipClasses } from './brand';

/*
  The brand layer's shared pieces. What must hold: the no-image artwork is the event's own
  title (never a letter tile), a real picture is drawn as a picture in its box, and state is
  never carried by colour alone.
*/
describe('EventArtwork', () => {
  it('draws the title as artwork, on the stage tone, when there is no picture', () => {
    const html = renderToStaticMarkup(
      <EventArtwork alt="" title="Notes From the Local Train" eyebrow="Comedy" />,
    );
    expect(html).toContain('data-artwork="fallback"');
    expect(html).toContain('data-brand-tone="stage"');
    expect(html).toContain('aria-label="Notes From the Local Train"');
    expect(html).toContain('>Notes From the Local Train<');
    expect(html).toContain('>Comedy<');
    expect(html).not.toContain('<img');
  });

  it('lifts the no-photo tile off a dark band instead of drawing black on black', () => {
    const html = renderToStaticMarkup(
      <EventArtwork alt="" title="Pilot Currency Film" ratio="2:3" tone="lift" />,
    );
    expect(html).toContain('data-artwork="fallback"');
    expect(html).not.toContain('data-brand-tone="stage"');
    expect(html).toContain('bg-brand-sunken');
    expect(html).not.toContain('bg-brand-canvas');
    // A narrow poster sets the title at card size and lets it run to five lines.
    expect(html).toContain('line-clamp-5');
  });

  it('draws the picture, with the focal point, when there is one', () => {
    const html = renderToStaticMarkup(
      <EventArtwork
        src="https://example.test/a.jpg"
        alt="Crowd at an open-air concert"
        title="Neon Raga"
        ratio="16:9"
        objectPosition="50% 30%"
      />,
    );
    expect(html).toContain('<img');
    expect(html).toContain('alt="Crowd at an open-air concert"');
    expect(html).toContain('object-position:50% 30%');
    expect(html).toContain('aspect-video');
    expect(html).not.toContain('data-artwork="fallback"');
  });
});

describe('brand controls', () => {
  it('gives every button size the 36px floor and the default the 44px touch target', () => {
    expect(brandButtonClasses()).toContain('h-11');
    expect(brandButtonClasses('quiet', 'sm')).toContain('h-9');
    expect(brandButtonClasses('marigold')).toContain('text-brand-on-marigold');
  });

  it('shows a selected chip by fill and contrast, not only by hue', () => {
    expect(brandChipClasses(true)).toContain('bg-brand-action text-brand-on-action');
    expect(brandChipClasses(false)).toContain('border');
  });

  it('always writes a status in words', () => {
    const html = renderToStaticMarkup(<BrandStatusPill status="live">Today</BrandStatusPill>);
    expect(html).toContain('>Today<');
    expect(html).toContain('bg-brand-marigold');
  });
});
