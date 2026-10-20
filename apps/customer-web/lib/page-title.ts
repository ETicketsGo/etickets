import type { Metadata } from 'next';

/** The tab-title template for every screen: "<Page> - ETicketsGo" (owner, 2026-10-19). */
export const TITLE_TEMPLATE = '%s - ETicketsGo';

/**
 * The title of a section whose pages name themselves.
 *
 * Next applies a template only from the nearest ancestor that HAS one. A section layout with a
 * plain string title ("Your account", "Events") therefore cut the root template off from every
 * page below it, so "My tickets", "Profile" and each event's own name reached the tab bare,
 * without "- ETicketsGo". The section names itself in full and hands the template on.
 */
export function sectionTitle(name: string): Metadata['title'] {
  return { absolute: `${name} - ETicketsGo`, template: TITLE_TEMPLATE };
}
