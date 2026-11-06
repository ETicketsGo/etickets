import {
  RUNTIME_CONFIG_HEADERS,
  readServerRuntimeConfig,
  runtimeConfigScript,
} from '@eticketsgo/web-kit/runtime-config';

/*
  `/runtime-config.js`: this container's public configuration, read at REQUEST time (AR-17).
  Loaded by the root layout before the app's own scripts, so one image can run in QA, UAT and
  production with each environment's own addresses. Only the allowlisted public keys in
  `@eticketsgo/web-kit/runtime-config` are served; nothing secret is ever in them.
*/
export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export function GET() {
  return new Response(runtimeConfigScript(readServerRuntimeConfig()), {
    headers: RUNTIME_CONFIG_HEADERS,
  });
}
