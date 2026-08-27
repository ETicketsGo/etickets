import type { ReactNode } from 'react';

/**
 * A pass-through, on purpose.
 *
 * `<html>` and `<body>` moved into `app/[locale]/layout.tsx` because the `lang` attribute is
 * a property of the CONTENT, and the content's language is only known once the locale
 * segment has been resolved. Next still requires a root layout above the dynamic segment,
 * and a root that also emitted `<html>` would produce two of them.
 *
 * Everything else — fonts, metadata, chrome, providers — is in the locale layout with the
 * markup it belongs to.
 */
export default function RootLayout({ children }: { children: ReactNode }) {
  return children;
}
