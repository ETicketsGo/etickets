import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

/*
  The root 404 renders outside the locale layout, so it must carry its own <html lang>. This
  route file is read as text (an async server component that owns <html> does not render in a
  unit test); the tree it draws is rendered in lib/not-found-shell.test.ts, and the page itself
  is checked in a browser (axe html-has-lang) in the PR's evidence.
*/
const source = readFileSync(resolve(__dirname, 'not-found.tsx'), 'utf8');

describe('the 404 outside any locale', () => {
  it('owns <html> and declares its language (WCAG 3.1.1)', () => {
    expect(source).toMatch(/<html\s+lang="en"/);
  });

  it('draws the storefront shell around the 404, not a bare page', () => {
    // The ways out (search, home, Browse) and the legal footer are checked by rendering
    // `NotFoundInShell` in lib/not-found-shell.test.ts.
    expect(source).toMatch(/<NotFoundInShell\b/);
  });
});

describe('an unknown address inside a locale', () => {
  const catchAll = readFileSync(resolve(__dirname, '[locale]/[...rest]/page.tsx'), 'utf8');

  it('reaches the 404 inside the locale layout, through the catch-all', () => {
    // Without it Next answers with the root 404 above, outside the locale layout.
    expect(catchAll).toMatch(/notFound\(\)/);
    expect(readFileSync(resolve(__dirname, '[locale]/not-found.tsx'), 'utf8')).toMatch(
      /<NotFoundView\s*\/>/,
    );
  });
});
