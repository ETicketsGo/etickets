import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

/*
  An explicit <head> in a console's root layout made React error #418 on about one load in ten
  on QA (the hydration cursor met Next's own <meta charset> where the layout's <script> was
  expected), and the client re-render that followed dropped the saved dark mode. A real browser
  on the deployed build is the only thing that shows it, so this pins the cause.
*/
describe('console root layouts', () => {
  for (const app of ['admin-web', 'organizer-web']) {
    it(`${app} renders no explicit <head> and keeps the theme script in <body>`, () => {
      const src = readFileSync(resolve(__dirname, `../../../apps/${app}/app/layout.tsx`), 'utf8');
      const code = src.replace(/\{\/\*[\s\S]*?\*\/\}/g, '').replace(/\/\*[\s\S]*?\*\//g, '');
      expect(code).not.toMatch(/<head[\s>]/);
      expect(code).toMatch(
        /<body>\s*<script dangerouslySetInnerHTML=\{\{ __html: workspaceThemeScript \}\} \/>/,
      );
    });
  }
});
