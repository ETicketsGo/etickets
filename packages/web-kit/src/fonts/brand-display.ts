import localFont from 'next/font/local';
// The latin-ext subset (rupee sign, accented capitals) and the size-matched fallback face.
import '../../fonts/bricolage-grotesque.css';

/*
  The brand display face (docs/design/DESIGN-SYSTEM.md): Bricolage Grotesque, for headlines,
  event titles and a console's page title - never for running text, which stays Inter.

  Opt-in. Nothing imports this module until a page adopts the brand layer, so no app preloads
  a file it does not use and no existing page changes. An app that adopts it adds
  `brandDisplay.variable` to the element that carries `data-brand`, and the preset's
  `font-brand-display` resolves to it.

  Optical size is left variable (12-96): the browser matches it to the font size, which is
  what lets one family be loud in a storefront hero and quiet in a console title. Self-hosted
  and split the same way as ./inter.ts, for the same reasons; see fonts/README.md.
*/
export const brandDisplay = localFont({
  src: '../../fonts/bricolage-grotesque-latin.woff2',
  weight: '500 800',
  style: 'normal',
  variable: '--font-brand-display',
  display: 'swap',
  // The fallback face is generated into the .css file with the font's own metrics.
  adjustFontFallback: false,
  fallback: ["'Bricolage Grotesque Fallback'"],
  declarations: [
    { prop: 'font-family', value: 'Bricolage Grotesque' },
    {
      prop: 'unicode-range',
      value:
        'U+0000-00FF, U+0131, U+0152-0153, U+02BB-02BC, U+02C6, U+02DA, U+02DC, U+0304, U+0308, U+0329, U+2000-206F, U+20AC, U+2122, U+2191, U+2193, U+2212, U+2215, U+FEFF, U+FFFD',
    },
  ],
});
