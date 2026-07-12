import type { Metadata } from 'next';
import { Inter } from 'next/font/google';
import './globals.css';
import { WebProviders } from '@eticketsgo/web-kit';

const inter = Inter({ subsets: ['latin'], variable: '--font-inter', display: 'swap' });

export const metadata: Metadata = {
  title: 'ETicketsGo — Organizer',
  description: 'Create events, manage orders, check in attendees, and track revenue.',
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
