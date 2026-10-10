import localFont from 'next/font/local';
// Every Google subset except latin; downloaded only when a title shows a character from one.
import '../../fonts/plus-jakarta-sans.css';

/*
  The consoles' display face: page titles and the big numbers only (DESIGN-DIRECTION). Inter
  stays the face for everything a person reads at length. Self-hosted, named and split the same
  way as ./inter.ts, for the same reasons.
*/
export const display = localFont({
  src: '../../fonts/plus-jakarta-sans-latin.woff2',
  // The two weights the consoles asked Google for. The file is variable, so one range.
  weight: '600 700',
  style: 'normal',
  variable: '--font-display',
  display: 'swap',
  // The size-matched Arial face is in the .css file with Google's exact figures; next/font's
  // own calculation differs slightly, which would move text while the font loads.
  adjustFontFallback: false,
  fallback: ["'Plus Jakarta Sans Fallback'"],
  declarations: [
    { prop: 'font-family', value: 'Plus Jakarta Sans' },
    {
      prop: 'unicode-range',
      value:
        'U+0000-00FF, U+0131, U+0152-0153, U+02BB-02BC, U+02C6, U+02DA, U+02DC, U+0304, U+0308, U+0329, U+2000-206F, U+20AC, U+2122, U+2191, U+2193, U+2212, U+2215, U+FEFF, U+FFFD',
    },
  ],
});
