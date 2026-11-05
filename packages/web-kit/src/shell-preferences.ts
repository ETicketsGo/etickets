/**
 * The cookie that tells the SERVER whether this device keeps the console sidebar collapsed.
 *
 * The preference lives in localStorage (`etg_sidebar_collapsed`), which a server render cannot
 * read, so the console was drawn with the sidebar open and folded it a moment after load: a
 * 232px sidebar shrinking to the 72px rail on every refresh. The shell writes this cookie beside
 * localStorage; each console's root layout reads it and hands it to `WebProviders`, so the
 * first paint already has the rail. A layout preference, nothing more - no identity in it.
 *
 * Kept out of shell.tsx because that is a client module and a server layout imports this name.
 */
export const SIDEBAR_COLLAPSED_COOKIE = 'etg_sidebar_collapsed';
