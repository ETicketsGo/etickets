import { NextResponse, type NextRequest } from 'next/server';
import {
  ACCESS_JWT_HEADER,
  checkRequest,
  cloudflareKeys,
  readGateConfig,
  type GateConfig,
} from './lib/access-gate';

/*
  The identity-aware access gate's origin check (lib/access-gate.ts,
  docs/security/ADMIN-ACCESS-GATE.md). With ADMIN_ACCESS_GATE unset - every environment today -
  this returns straight away and the console behaves exactly as before.

  Node.js runtime, so the settings are read from the container's environment when the server
  starts, not baked in at build time: one image serves QA, UAT and production, and the gate is
  switched with a variable, not a rebuild.
*/

let cached: GateConfig | null = null;
let warnedMisconfigured = false;

function gateConfig(): GateConfig {
  if (!cached) {
    cached = readGateConfig(process.env);
    console.log(
      JSON.stringify({
        msg: 'admin_access_gate',
        mode: cached.mode,
        teamDomain: cached.teamDomain || null,
        configured: cached.problem === null,
      }),
    );
  }
  return cached;
}

function refused(): NextResponse {
  return new NextResponse('Access denied.\n', {
    status: 403,
    headers: {
      'content-type': 'text/plain; charset=utf-8',
      'cache-control': 'no-store',
      'x-robots-tag': 'noindex, nofollow, noarchive',
    },
  });
}

export default async function middleware(request: NextRequest) {
  const cfg = gateConfig();
  if (cfg.mode === 'off') return NextResponse.next();
  const { pathname } = request.nextUrl;
  const token = request.headers.get(ACCESS_JWT_HEADER);
  const verdict = await checkRequest(cfg, pathname, token, cloudflareKeys(cfg.teamDomain));
  if (verdict.allow) return NextResponse.next();

  if (verdict.reason === 'misconfigured') {
    if (!warnedMisconfigured) {
      warnedMisconfigured = true;
      console.error(
        JSON.stringify({
          msg: 'admin_access_gate_misconfigured',
          mode: cfg.mode,
          detail: verdict.detail,
        }),
      );
    }
  } else {
    // Never the token itself: only why it was refused and where the request was going.
    console.warn(
      JSON.stringify({
        msg:
          cfg.mode === 'enforce' ? 'admin_access_gate_refused' : 'admin_access_gate_would_refuse',
        reason: verdict.reason,
        detail: verdict.detail ?? null,
        method: request.method,
        path: pathname,
      }),
    );
  }
  return cfg.mode === 'enforce' ? refused() : NextResponse.next();
}

export const config = {
  runtime: 'nodejs',
  /*
    No path filter: the gate covers every request the server answers, including /_next/static,
    /_next/image and Server Action posts, which are exactly what internet scanners probe.
  */
};
