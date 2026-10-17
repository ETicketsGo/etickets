import type { Metadata } from 'next';
import {
  Building2,
  Mail,
  Phone,
  MapPin,
  Clock,
  Briefcase,
  Newspaper,
  Handshake,
  LifeBuoy,
} from 'lucide-react';
import { BUSINESS_DETAILS, publishedDetail, canReachSupport } from '@eticketsgo/web-kit';
import { Container, Section } from '@/components/marketing/kit';
import { PageHero, NoticeBanner } from '@/components/marketing/blocks';
import { ContactForm } from '@/components/marketing/contact-form';
import { Link } from '@/i18n/navigation';
import { INDIA_OPERATOR } from '@eticketsgo/shared-types';
import { INDIA_OPERATOR_SENTENCE, LEGAL_INFORMATION_HREF } from '@/lib/legal-entity';

export const metadata: Metadata = {
  title: 'Contact',
  description: `Contact ETicketsGo, operated in India by ${INDIA_OPERATOR.legalName}: support and general enquiries.`,
  alternates: { canonical: '/contact' },
};

/*
  Every channel reads from the one place the business details live. A channel with no published
  address is not shown at all, because the alternative - the `.example` addresses this page used
  to carry - tells a customer with a payment problem to write somewhere nothing arrives.
*/
const CHANNELS = [
  { icon: Briefcase, title: 'Sales', detail: publishedDetail(BUSINESS_DETAILS.salesEmail) },
  { icon: LifeBuoy, title: 'Support', detail: publishedDetail(BUSINESS_DETAILS.supportEmail) },
  {
    icon: Handshake,
    title: 'Partnerships',
    detail: publishedDetail(BUSINESS_DETAILS.partnershipsEmail),
  },
  { icon: Newspaper, title: 'Media', detail: publishedDetail(BUSINESS_DETAILS.mediaEmail) },
].filter((c): c is typeof c & { detail: string } => c.detail !== null);

const FACTS = [
  { icon: Phone, label: publishedDetail(BUSINESS_DETAILS.supportPhone) },
  { icon: MapPin, label: publishedDetail(BUSINESS_DETAILS.postalAddress) },
  { icon: Clock, label: publishedDetail(BUSINESS_DETAILS.supportHours) },
  { icon: Mail, label: publishedDetail(BUSINESS_DETAILS.supportEmail) },
].filter((r): r is typeof r & { label: string } => r.label !== null);

const SUPPORT_EMAIL = publishedDetail(BUSINESS_DETAILS.supportEmail);

export default function ContactPage() {
  const reachable = canReachSupport();

  return (
    <>
      <PageHero
        eyebrow="Contact"
        title="Let's talk"
        lead="Whether you're planning your first event or your fiftieth, we'd love to help."
      />
      <Section>
        <Container>
          {!reachable && (
            <div className="mx-auto max-w-5xl">
              <NoticeBanner>
                We have not published a phone number or a postal address yet. The form on this page
                does reach our support team, so it is the way to get hold of us today.
              </NoticeBanner>
            </div>
          )}
          {/*
            Who the visitor is writing to. The DLT review (STPL/MSG91) asks that the Contact page
            name the Indian operating company, and a customer deserves to know the same thing.
            The address beside it is the support mailbox the form and every legal page use.
          */}
          <div
            data-testid="contact-operator"
            className="mx-auto mt-10 max-w-5xl rounded-2xl border border-border bg-background-surface p-5 shadow-sm"
          >
            <div className="flex items-start gap-3">
              <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-tint-primary text-action-primary">
                <Building2 className="h-5 w-5" />
              </span>
              <div className="space-y-1">
                <h2 className="text-[0.9375rem] font-semibold text-text-primary">
                  {INDIA_OPERATOR.legalName}
                </h2>
                <p className="text-[0.9375rem] text-text-secondary">{INDIA_OPERATOR_SENTENCE}</p>
                {SUPPORT_EMAIL && (
                  <p className="text-[0.9375rem] text-text-secondary">
                    Support email:{' '}
                    <a
                      className="font-medium text-action-primary hover:underline"
                      href={`mailto:${SUPPORT_EMAIL}`}
                    >
                      {SUPPORT_EMAIL}
                    </a>
                  </p>
                )}
                <p className="text-[0.9375rem]">
                  <Link
                    className="font-medium text-action-primary hover:underline"
                    href={LEGAL_INFORMATION_HREF}
                  >
                    Legal and business information
                  </Link>
                </p>
              </div>
            </div>
          </div>
          <div
            className={`mx-auto mt-10 grid max-w-5xl gap-8 ${
              CHANNELS.length > 0 || FACTS.length > 0 ? 'lg:grid-cols-[1fr_1.2fr]' : 'max-w-2xl'
            }`}
          >
            {(CHANNELS.length > 0 || FACTS.length > 0) && (
              <div className="space-y-6">
                {CHANNELS.length > 0 && (
                  <div className="grid gap-4 sm:grid-cols-2">
                    {CHANNELS.map((c) => (
                      <div
                        key={c.title}
                        className="rounded-2xl border border-border bg-background-surface p-5 shadow-sm"
                      >
                        <span className="flex h-10 w-10 items-center justify-center rounded-xl bg-tint-primary text-action-primary">
                          <c.icon className="h-5 w-5" />
                        </span>
                        <h3 className="mt-3 text-[0.9375rem] font-semibold text-text-primary">
                          {c.title}
                        </h3>
                        <p className="mt-1 text-caption text-text-muted">{c.detail}</p>
                      </div>
                    ))}
                  </div>
                )}
                {FACTS.length > 0 && (
                  <div className="space-y-3 rounded-2xl border border-border bg-background-surface p-5 shadow-sm">
                    {FACTS.map((r) => (
                      <div
                        key={r.label}
                        className="flex items-center gap-3 text-[0.9375rem] text-text-secondary"
                      >
                        <r.icon className="h-4 w-4 text-action-primary" />
                        {r.label}
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )}
            <ContactForm />
          </div>
        </Container>
      </Section>
    </>
  );
}
