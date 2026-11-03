import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/*
  ── WHAT THE SERVER CANNOT SEE MUST NOT DECIDE THE FIRST PAINT ─────────────────────────
  A value the server cannot read (the token in localStorage, `navigator`, the browser's clock
  zone) that picks the markup during render makes the server HTML and the first client render
  disagree. React then throws the server HTML away (error #418) and draws the page again.
  Signed-in visitors hit that on EVERY event page: the review form was gated on
  `tokenStore.access` in render, so the sticky Book bar blinked out and LCP doubled on a phone.
  The browser check is `apps/e2e/tests/storefront-load-stability.spec.ts`; these pin the source.
*/
const read = (path: string) => readFileSync(fileURLToPath(new URL(path, import.meta.url)), 'utf8');
// Code only: the comments are allowed to name what the code no longer does.
const code = (path: string) =>
  read(path)
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');

describe('render-time reads that differ between server and browser', () => {
  it('the event page decides "signed in" from the session hint until mount, not the token', () => {
    const page = code('../app/[locale]/events/[slug]/event-page.tsx');
    expect(page).not.toMatch(/tokenStore/);
    expect(page).not.toMatch(/typeof window/);
    expect(page).toMatch(/const \{ authed \} = useShellAuth\(initialSignedIn\)/);
  });

  it('the event route hands the page the hint the server read', () => {
    const route = code('../app/[locale]/events/[slug]/page.tsx');
    expect(route).toMatch(/await serverSessionHint\(\)/);
    expect(route).toMatch(/<EventDetailPage initialSignedIn=\{signedInHint\} \/>/);
  });

  it('the copy button waits for mount instead of reading navigator in render', () => {
    const source = code('../components/reference-code.tsx');
    expect(source).not.toMatch(/typeof navigator/);
    expect(source).toMatch(/const canCopy = mounted && /);
  });

  it('the home hero never asks "today?" in the process zone', () => {
    const source = code('../components/home/parts.tsx');
    expect(source).not.toMatch(/isTodayAt\(event\.nextSessionAt, eventZone\(event\)\)/);
    expect(source).toMatch(/eventZone\(event\) \?\? readerZone/);
  });
});
