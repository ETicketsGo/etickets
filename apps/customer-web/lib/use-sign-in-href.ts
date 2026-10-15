'use client';

import { useEffect, useState } from 'react';
import { usePathname } from '@/i18n/navigation';
import { signInHref } from '@/lib/sign-in-return';

/**
 * The Sign in link for the page being looked at: `/login?next=<this page>`, so signing in brings
 * the person back here instead of to "My tickets".
 *
 * The query string is read after mount, not with `useSearchParams`: this runs in the site header,
 * and `useSearchParams` there would turn every statically rendered page into a client-rendered
 * one. Until then the link carries the path alone, which is right for almost every page.
 */
export function useSignInHref(): string {
  const pathname = usePathname();
  const [search, setSearch] = useState('');
  useEffect(() => setSearch(window.location.search), [pathname]);
  return signInHref(`${pathname}${search}`);
}
