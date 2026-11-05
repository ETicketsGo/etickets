import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { ContactPhoneField } from './contact-phone-field';
import { sourceProblem, IMAGE_SPECS } from '../app/organizer/settings/image-crop';

const render = (value: string, homeCountry: string | null) =>
  renderToStaticMarkup(
    <ContactPhoneField
      id="p"
      label="Finance contact phone"
      value={value}
      homeCountry={homeCountry}
      onChange={() => undefined}
    />,
  );
const selected = (html: string) => html.match(/<option value="([A-Z]*)" selected="">/)?.[1] ?? '';
const number = (html: string) => html.match(/id="p"[^>]*value="([^"]*)"/)?.[1] ?? null;

describe('the settings phone field', () => {
  it('splits a stored E.164 number into its country and digits', () => {
    const html = render('+12085550100', 'United States');
    expect(selected(html)).toBe('US');
    expect(number(html)).toBe('2085550100');
  });

  it('keeps a Canadian organization on Canada for a +1 number', () => {
    expect(selected(render('+14165550100', 'Canada'))).toBe('CA');
  });

  it('opens a blank field on the organization country code, with digits-only input', () => {
    const html = render('', 'India');
    expect(selected(html)).toBe('IN');
    expect(html).toMatch(/inputmode="numeric"/i);
  });

  it('shows a number saved in an older shape as it is, and says it is kept until changed', () => {
    const html = render('+91 98480 22338 ext 2', 'India');
    expect(html).toContain('Saved as &quot;+91 98480 22338 ext 2&quot;');
    expect(html).toContain('stays exactly as it is');
  });
});

describe('the image files Settings accepts', () => {
  const file = (type: string, size = 1000) => new File([new Uint8Array(size)], 'x', { type });

  it('takes JPG, PNG and WebP', () => {
    for (const t of ['image/jpeg', 'image/png', 'image/webp'])
      expect(sourceProblem(file(t))).toBeNull();
  });

  it('refuses other types and absurdly large sources with a message', () => {
    expect(sourceProblem(file('image/gif'))).toMatch(/JPG, PNG or WebP/);
    expect(sourceProblem(file('application/pdf'))).toMatch(/JPG, PNG or WebP/);
    expect(sourceProblem(file('image/png', 26_000_000))).toMatch(/too large/);
  });

  it('crops the cover to 3:1 and the picture to a square, within the API upload limits', () => {
    expect(IMAGE_SPECS.cover.aspect).toBe(3);
    expect(IMAGE_SPECS.logo.aspect).toBe(1);
    expect(IMAGE_SPECS.cover.maxBytes).toBeLessThanOrEqual(3_000_000);
    expect(IMAGE_SPECS.logo.maxBytes).toBeLessThanOrEqual(1_000_000);
  });
});
