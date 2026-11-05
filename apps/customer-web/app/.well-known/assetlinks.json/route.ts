import { NextResponse } from 'next/server';
import { buildAssetLinks } from '@/lib/android-asset-links';

// Read at request time so each environment's deployment decides which apps it trusts.
export const dynamic = 'force-dynamic';

export function GET() {
  const body = buildAssetLinks(process.env.ANDROID_APP_LINKS);
  if (!body) return new NextResponse('Not found', { status: 404 });
  // Android requires application/json, served without a redirect.
  return NextResponse.json(body, { headers: { 'Cache-Control': 'public, max-age=3600' } });
}
