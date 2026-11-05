import { NextResponse } from 'next/server';
import { buildAppleAppSiteAssociation } from '@/lib/apple-app-site-association';

// Read at request time so each environment's deployment decides which apps it trusts.
export const dynamic = 'force-dynamic';

export function GET() {
  const body = buildAppleAppSiteAssociation(process.env.APPLE_APP_IDS);
  if (!body) return new NextResponse('Not found', { status: 404 });
  // Apple requires JSON at this extensionless path, served without a redirect.
  return NextResponse.json(body, { headers: { 'Cache-Control': 'public, max-age=3600' } });
}
