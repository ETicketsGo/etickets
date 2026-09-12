'use client';

import type { ComponentProps } from 'react';
import { ButtonLink as KitButtonLink } from '@eticketsgo/web-kit';
import { Link } from '@/i18n/navigation';

/**
 * The shared button-styled link, rendered through the storefront's locale-aware Link.
 *
 * ── WHY THE STOREFRONT HAS ITS OWN ─────────────────────────────────────────────────
 * The kit's ButtonLink renders `next/link`, which writes the href exactly as given. On a
 * French page that dropped `/fr-CA` from every button — "Choose seats", "Back to event",
 * "View tickets" — and put the reader back into English with no way to tell why.
 *
 * A client component so the Link is handed over on the client: a component cannot be passed
 * as a prop across the server/client boundary, and several pages that use this are server
 * components.
 */
export function ButtonLink(props: Omit<ComponentProps<typeof KitButtonLink>, 'linkComponent'>) {
  return <KitButtonLink {...props} linkComponent={Link} />;
}
