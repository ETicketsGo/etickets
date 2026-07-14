// Side-effecting bootstrap module. Imported FIRST in main.ts (before any other
// import) so tracing can patch instrumented libraries before they are loaded and
// Sentry is ready to capture from the very start. Both calls are complete no-ops
// unless their env is configured, so default behaviour is unchanged.
import { startTracing } from './tracing';
import { initSentry } from './sentry';

startTracing();
initSentry();
