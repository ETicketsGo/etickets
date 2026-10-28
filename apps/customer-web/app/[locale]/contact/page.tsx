import { localizedMetadata } from '@/lib/seo';
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
import { contactOperator, LEGAL_INFORMATION_HREF } from '@/lib/legal-entity';
import { resolveSelectedMarket } from '@/lib/market';
import { BrandPage } from '@/components/storefront-brand';

type ContactProps = {
  params: Promise<{ locale: string }>;
  searchParams: Promise<{ country?: string | string[] }>;
};

/*
  The company named here follows the market the reader CHOSE (`?country=`, then the
  `etg_selected_market` cookie), never the network's guess. With no choice the page names
  both companies, so the server HTML is never wrong before the page hydrates.
*/
export async function generateMetadata({ params, searchParams }: ContactProps) {
  const market = await resolveSelectedMarket((await searchParams).country);
  return localizedMetadata('/contact', {
    title: 'Contact',
    description: contactOperator(market).description,
  })({ params });
}

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

export default async function ContactPage({ searchParams }: Pick<ContactProps, 'searchParams'>) {
  const reachable = canReachSupport();
  const operator = contactOperator(await resolveSelectedMarket((await searchParams).country));

  return (
    <BrandPage>
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
            className="mx-auto mt-10 max-w-5xl rounded-brand-card border border-brand-line bg-brand-surface p-5"
          >
            <div className="flex items-start gap-3">
              <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-brand-control bg-brand-sunken text-brand-ink">
                <Building2 className="h-5 w-5" />
              </span>
              <div className="space-y-1">
                <h2 className="text-brand-ui font-semibold text-brand-ink">{operator.heading}</h2>
                <p className="text-brand-ui text-brand-ink-2">{operator.sentence}</p>
                {SUPPORT_EMAIL && (
                  <p className="text-brand-ui text-brand-ink-2">
                    Support email:{' '}
                    <a
                      className="font-medium text-brand-ink underline decoration-brand-line-strong underline-offset-4 hover:text-brand-gold-text hover:decoration-brand-gold-text"
                      href={`mailto:${SUPPORT_EMAIL}`}
                    >
                      {SUPPORT_EMAIL}
                    </a>
                  </p>
                )}
                <p className="text-brand-ui">
                  <Link
                    className="font-medium text-brand-ink underline decoration-brand-line-strong underline-offset-4 hover:text-brand-gold-text hover:decoration-brand-gold-text"
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
                        className="rounded-brand-card border border-brand-line bg-brand-surface p-5"
                      >
                        <span className="flex h-10 w-10 items-center justify-center rounded-brand-control bg-brand-sunken text-brand-ink">
                          <c.icon className="h-5 w-5" />
                        </span>
                        <h3 className="mt-3 text-brand-ui font-semibold text-brand-ink">
                          {c.title}
                        </h3>
                        <p className="mt-1 text-brand-meta text-brand-ink-3">{c.detail}</p>
                      </div>
                    ))}
                  </div>
                )}
                {FACTS.length > 0 && (
                  <div className="space-y-3 rounded-brand-card border border-brand-line bg-brand-surface p-5">
                    {FACTS.map((r) => (
                      <div
                        key={r.label}
                        className="flex items-center gap-3 text-brand-ui text-brand-ink-2"
                      >
                        <r.icon className="h-4 w-4 text-brand-ink" />
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
    </BrandPage>
  );
}
