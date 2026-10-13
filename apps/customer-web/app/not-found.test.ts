import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

/*
  The root 404 renders outside the locale layout, so it must carry its own <html lang>. This
  suite has no JSX transform (its tests are plain .ts), so the file is read as text; the
  rendered page is checked in a browser (axe html-has-lang) in the PR's evidence.
*/
const source = readFileSync(resolve(__dirname, 'not-found.tsx'), 'utf8');

describe('the 404 outside any locale', () => {
  it('owns <html> and declares its language (WCAG 3.1.1)', () => {
    expect(source).toMatch(/<html\s+lang="en"/);
  });

  it('still offers a way out', () => {
    expect(source).toContain('href="/"');
    expect(source).toContain('href="/events"');
  });
});
