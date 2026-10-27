import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { Dialog } from './components';

/*
  `sheetOnMobile` turns the dialog into a bottom sheet below `sm` and keeps the centred panel
  from `sm` up. It is opt-in: the organizer and admin consoles share this Dialog, and every
  caller that does not ask for the sheet must get exactly the centred panel it had.
*/
const noop = () => {};

function render(props: { sheetOnMobile?: boolean; brand?: boolean; size?: 'md' | 'lg' }) {
  return renderToStaticMarkup(
    <Dialog open onClose={noop} title="Title" description="What this is for" {...props}>
      Body
    </Dialog>,
  );
}

const classesOf = (html: string, marker: RegExp) => {
  const tag = html.match(marker)?.[0] ?? '';
  return new Set((tag.match(/class="([^"]*)"/)?.[1] ?? '').split(/\s+/).filter(Boolean));
};
const overlay = (html: string) => classesOf(html, /<div[^>]*class="fixed inset-0[^"]*"[^>]*>/);
const panel = (html: string) => classesOf(html, /<div[^>]*role="dialog"[^>]*>/);

describe('Dialog', () => {
  it('is the centred panel by default', () => {
    const html = render({ brand: true });
    const o = overlay(html);
    const p = panel(html);
    expect(o.has('items-center')).toBe(true);
    expect(o.has('p-4')).toBe(true);
    expect(o.has('items-end')).toBe(false);
    expect(p.has('rounded-brand-card')).toBe(true);
    expect(p.has('max-w-md')).toBe(true);
    expect(p.has('rounded-t-brand-card')).toBe(false);
    expect([...p].some((c) => c.includes('safe-area'))).toBe(false);
    expect(html).not.toContain('data-sheet');
  });

  it('keeps the console frame by default', () => {
    const p = panel(render({ size: 'lg' }));
    expect(p.has('rounded-2xl')).toBe(true);
    expect(p.has('max-w-2xl')).toBe(true);
    expect(p.has('rounded-t-2xl')).toBe(false);
  });

  it('with sheetOnMobile: a bottom sheet on a phone, the centred panel from sm up', () => {
    const html = render({ brand: true, sheetOnMobile: true });
    const o = overlay(html);
    const p = panel(html);
    expect(o.has('items-end')).toBe(true);
    expect(o.has('sm:items-center')).toBe(true);
    expect(o.has('sm:p-4')).toBe(true);
    expect(o.has('p-4')).toBe(false);
    expect(p.has('w-full')).toBe(true);
    expect(p.has('rounded-t-brand-card')).toBe(true);
    expect(p.has('sm:rounded-brand-card')).toBe(true);
    expect(p.has('sm:max-w-md')).toBe(true);
    expect(p.has('max-w-md')).toBe(false);
    expect(p.has('pb-[calc(1.5rem+env(safe-area-inset-bottom))]')).toBe(true);
    expect(p.has('sm:pb-6')).toBe(true);
    // Still a labelled modal dialog.
    expect(html).toContain('aria-modal="true"');
    expect(html).toContain('aria-label="Title"');
    expect(html).toContain('aria-describedby=');
  });
});
