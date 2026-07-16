import { NextResponse } from 'next/server';

// Liveness probe for the web tier so a load balancer / orchestrator can detect a
// wedged Next server and stop routing traffic to it. Static, no external calls.
export const dynamic = 'force-dynamic';

export function GET() {
  return NextResponse.json({ status: 'ok', app: 'admin-web' });
}
