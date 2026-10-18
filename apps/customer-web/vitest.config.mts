import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

/*
  Most of this app's tests read source files as text. The 404 test renders a real component
  tree (the storefront shell), so the suite needs what Next gives the app: the `@/` path from
  tsconfig, and JSX compiled with React's automatic runtime (tsconfig says `preserve`, which is
  Next's job and would leave the JSX for Node to choke on). next-intl is bundled into the test
  rather than loaded by Node, so its `next/navigation` import resolves and the test's mock of it
  applies.
*/
export default defineConfig({
  resolve: { alias: { '@': fileURLToPath(new URL('.', import.meta.url)) } },
  oxc: { jsx: { runtime: 'automatic' } },
  test: { server: { deps: { inline: [/next-intl/] } } },
});
