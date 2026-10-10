import localFont from 'next/font/local';
// Every Google subset except latin (latin-ext with the rupee sign, cyrillic, greek, vietnamese):
// the browser downloads one only when a page shows a character from it.
import '../../fonts/inter.css';

/*
  The UI face: everything a person reads at length. Served from this repository, not Google Fonts.

  `next/font/google` downloads font files while `next build` runs, so a build failed whenever
  that download did (CI and Railway both saw "An error occurred in `next/font`"). These are the
  files Google served us, cut from the google/fonts originals the same way: one file per Google
  subset, Inter's optical-size axis fixed at 14. See fonts/README.md at the package root.

  The family is named `Inter`, as `next/font/google` named it, so the latin face here and the
  subsets in fonts/inter.css make one family; the unicode-range is Google's "latin" range, which
  make-fonts.py also uses. next/font needs the call at module scope, literal options and a path
  relative to this file, so the loader lives here once. The display face is its own module so
  the storefront, which does not use it, does not preload it.
*/
export const inter = localFont({
  src: '../../fonts/inter-latin.woff2',
  // One variable file covers every weight, as Google's did.
  weight: '100 900',
  style: 'normal',
  variable: '--font-inter',
  display: 'swap',
  // The size-matched Arial face is in the .css file with Google's exact figures; next/font's
  // own calculation differs slightly, which would move text while the font loads.
  adjustFontFallback: false,
  fallback: ["'Inter Fallback'"],
  declarations: [
    { prop: 'font-family', value: 'Inter' },
    {
      prop: 'unicode-range',
      value:
        'U+0000-00FF, U+0131, U+0152-0153, U+02BB-02BC, U+02C6, U+02DA, U+02DC, U+0304, U+0308, U+0329, U+2000-206F, U+20AC, U+2122, U+2191, U+2193, U+2212, U+2215, U+FEFF, U+FFFD',
    },
  ],
});
