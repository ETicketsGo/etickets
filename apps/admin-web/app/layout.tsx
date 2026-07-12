import type { Metadata } from 'next';
import { Inter } from 'next/font/google';
import './globals.css';
import { WebProviders } from '@eticketsgo/web-kit';

const inter = Inter({ subsets: ['latin'], variable: '--font-inter', display: 'swap' });

export const metadata: Metadata = {
  title: 'ETicketsGo — Admin',
  description: 'Platform administration: organizers, events, refunds, payouts, and audit.',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={inter.variable}>
      <body>
        <WebProviders>{children}</WebProviders>
      </body>
    </html>
  );
}
