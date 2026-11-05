import { ImageResponse } from 'next/og';

/**
 * The storefront's sharing card, drawn from the brand tokens (paper, ink, gold) with the font
 * `next/og` bundles, so nothing is fetched while it renders. Used by `app/opengraph-image.tsx`
 * and `app/twitter-image.tsx`.
 */
export const SHARE_IMAGE_SIZE = { width: 1200, height: 630 };

const PAPER = '#F6F2EA';
const INK = '#16130F';
const GOLD = '#B8955A';

export function shareImage() {
  return new ImageResponse(
    <div
      style={{
        width: '100%',
        height: '100%',
        display: 'flex',
        flexDirection: 'column',
        justifyContent: 'center',
        padding: '0 96px',
        background: PAPER,
        color: INK,
      }}
    >
      <div
        style={{ display: 'flex', width: 120, height: 10, background: GOLD, marginBottom: 48 }}
      />
      <div style={{ display: 'flex', fontSize: 120, fontWeight: 700, letterSpacing: -4 }}>
        ETicketsGo
        <span style={{ color: GOLD }}>.</span>
      </div>
      <div style={{ display: 'flex', marginTop: 28, fontSize: 44, lineHeight: 1.3, maxWidth: 960 }}>
        Discover and book movies, events and experiences.
      </div>
    </div>,
    SHARE_IMAGE_SIZE,
  );
}
