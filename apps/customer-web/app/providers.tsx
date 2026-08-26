'use client';

// The shared providers (React Query + toasts), plus the one thing only the customer app
// needs: a single city preference the header chip and every browse page agree on. The
// organizer and admin consoles are not location-filtered, so this stays out of WebProviders.
import { CityProvider, WebProviders } from '@eticketsgo/web-kit';

export function Providers({ children }: { children: React.ReactNode }) {
  return (
    <WebProviders>
      <CityProvider>{children}</CityProvider>
    </WebProviders>
  );
}
