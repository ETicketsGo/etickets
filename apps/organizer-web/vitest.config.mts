import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

/*
  Most of this app's tests are plain functions. The component tests render real React (the
  suspended-organization screen, the invitation page), so the suite needs what Next gives the
  app: the `@/` path from tsconfig, and JSX compiled with React's automatic runtime (tsconfig
  says `preserve`, which is Next's job and would leave the JSX for Node to choke on). Same as
  the storefront's config.
*/
export default defineConfig({
  resolve: { alias: { '@': fileURLToPath(new URL('.', import.meta.url)) } },
  oxc: { jsx: { runtime: 'automatic' } },
});
