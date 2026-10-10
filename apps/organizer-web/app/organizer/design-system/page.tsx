import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { DesignSystemGallery } from './gallery';

export const metadata: Metadata = {
  title: 'Design system - ETicketsGo Organizer',
  robots: { index: false, follow: false },
};

/**
 * The living style page: every console primitive, in the current theme, for the teams that
 * build pages on them and for review. Not in the menu.
 *
 * Development servers only (`next dev`). Every built app - QA and UAT included, which run
 * NODE_ENV=production - answers 404, because the page is a catalogue of components with
 * sample figures and must never be mistaken for a real screen. `NODE_ENV` is inlined at build
 * time, so in a built bundle this is a constant and the gallery is not reachable at all.
 */
export default function DesignSystemPage() {
  if (process.env.NODE_ENV === 'production') notFound();
  return <DesignSystemGallery />;
}
