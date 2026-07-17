import type { Metadata } from 'next';
import {
  Mail,
  Phone,
  MapPin,
  Clock,
  Briefcase,
  Newspaper,
  Handshake,
  LifeBuoy,
} from 'lucide-react';
import { Container, Section } from '@/components/marketing/kit';
import { PageHero, NoticeBanner } from '@/components/marketing/blocks';
import { ContactForm } from '@/components/marketing/contact-form';

export const metadata: Metadata = {
  title: 'Contact',
  description:
    'Get in touch with ETicketsGo — sales, support, partnerships, media, and general enquiries.',
  alternates: { canonical: '/contact' },
};

const CHANNELS = [
  { icon: Briefcase, title: 'Sales', detail: 'sales@eticketsgo.example' },
  { icon: LifeBuoy, title: 'Support', detail: 'support@eticketsgo.example' },
  { icon: Handshake, title: 'Partnerships', detail: 'partners@eticketsgo.example' },
  { icon: Newspaper, title: 'Media', detail: 'press@eticketsgo.example' },
];

export default function ContactPage() {
  return (
    <>
      <PageHero
        eyebrow="Contact"
        title="Let's talk"
        lead="Whether you're planning your first event or your fiftieth, we'd love to help."
      />
      <Section>
        <Container>
          <div className="mx-auto max-w-5xl">
            <NoticeBanner>
              Contact details below (email, phone, address, hours, social) are{' '}
              <strong>placeholders</strong> for this demo build.
            </NoticeBanner>
          </div>
          <div className="mx-auto mt-10 grid max-w-5xl gap-8 lg:grid-cols-[1fr_1.2fr]">
            <div className="space-y-6">
              <div className="grid gap-4 sm:grid-cols-2">
                {CHANNELS.map((c) => (
                  <div
                    key={c.title}
                    className="rounded-2xl border border-border bg-background-surface p-5 shadow-sm"
                  >
                    <span className="flex h-10 w-10 items-center justify-center rounded-xl bg-action-primary/10 text-action-primary">
                      <c.icon className="h-5 w-5" />
                    </span>
                    <h3 className="mt-3 text-[0.9375rem] font-semibold text-text-primary">
                      {c.title}
                    </h3>
                    <p className="mt-1 text-caption text-text-muted">{c.detail}</p>
                  </div>
                ))}
              </div>
              <div className="space-y-3 rounded-2xl border border-border bg-background-surface p-5 shadow-sm">
                {[
                  { icon: Phone, label: '+00 0000 000000 (placeholder)' },
                  { icon: MapPin, label: 'Bengaluru, India (placeholder)' },
                  { icon: Clock, label: 'Mon–Fri, 9:00–18:00 IST (placeholder)' },
                  { icon: Mail, label: 'hello@eticketsgo.example (placeholder)' },
                ].map((r) => (
                  <div
                    key={r.label}
                    className="flex items-center gap-3 text-[0.9375rem] text-text-secondary"
                  >
                    <r.icon className="h-4 w-4 text-action-primary" />
                    {r.label}
                  </div>
                ))}
              </div>
            </div>
            <ContactForm />
          </div>
        </Container>
      </Section>
    </>
  );
}
