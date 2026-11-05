/*
  What a SERVER component may import from the kit.

  The package root re-exports client components and hooks, which a server component cannot
  call. These modules are plain functions with no React and no browser globals at import time:
  the API client (its token store reads nothing on the server, so every call is anonymous) and
  the pure city-scope rules, so the server renders the visitor's place exactly as the browser
  will.
*/
export { api, API_URL } from './api';
export * from './city-scope';
export { countryKey } from './place-groups';
