import type { Metadata } from 'next';
import { Container, PrimaryLink, SecondaryLink } from '@/components/marketing/kit';

export const metadata: Metadata = {
  title: 'Page not found',
  robots: { index: false, follow: true },
};

export default function NotFound() {
  return (
    <Container className="flex min-h-[60vh] flex-col items-center justify-center py-24 text-center">
      <span className="text-7xl font-bold tracking-tight text-action-primary/30">404</span>
      <h1 className="mt-4 text-3xl font-bold tracking-tight text-text-primary">
        This page took a different exit
      </h1>
      <p className="mt-3 max-w-md text-[0.9375rem] leading-relaxed text-text-secondary">
        The page you’re looking for doesn’t exist or may have moved. Let’s get you back to something
        useful.
      </p>
      <div className="mt-8 flex flex-col gap-3 sm:flex-row">
        <PrimaryLink href="/">Back to home</PrimaryLink>
        <SecondaryLink href="/events">Browse events</SecondaryLink>
      </div>
    </Container>
  );
}
