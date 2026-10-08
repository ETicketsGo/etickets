import type { Metadata } from 'next';
import { PageHero, Prose } from '@/components/marketing/blocks';
import { Link } from '@/i18n/navigation';
import {
  PolicyUpdated,
  OperatorLine,
  LegalDocument,
  BackToLegal,
} from '@/components/legal/policy-chrome';
import { resolveJurisdiction } from '@/lib/market';

/**
 * What this site stores on your device.
 *
 * -- WHY THIS PAGE IS SHORT, AND WHY THAT IS THE HONEST ANSWER ---------------------------
 * Every cookie listed below was found in the code, not assumed from a template. The
 * storefront loads no analytics, advertising or social tracker: there is no Google Tag
 * Manager, no gtag, no PostHog, no Mixpanel, no pixel. The only things stored are the ones
 * that make signing in and choosing a language work.
 *
 * That is why there is no consent banner and no "manage preferences" dialog - there is
 * nothing optional to manage. Adding one would imply tracking that does not happen, which is
 * its own kind of dishonesty. If a tracker is ever added, this page and that decision change
 * together.
 */
export const metadata: Metadata = {
  title: 'Cookies',
  description: 'What ETicketsGo stores on your device, and why.',
  alternates: { canonical: '/cookies' },
  robots: { index: true, follow: true },
};

export default async function CookiesPage({
  searchParams,
}: {
  searchParams: Promise<{ country?: string | string[] }>;
}) {
  const country = await resolveJurisdiction((await searchParams).country);

  return (
    <>
      <PageHero eyebrow="Legal" title="Cookies" lead="What we store on your device, and why." />
      <LegalDocument>
        <BackToLegal />
        <PolicyUpdated type="COOKIES" country={country} />
        <Prose>
          <h2>We do not track you</h2>
          <p>
            ETicketsGo loads no analytics, advertising or social media trackers. There is no tag
            manager and no advertising pixel on this site. Because nothing optional is stored, there
            is no cookie banner to dismiss and no preferences to manage.
          </p>

          <h2>What we do store</h2>
          <ul>
            <li>
              <strong>Signing in.</strong> When you sign in we store the credentials your browser
              needs to stay signed in, and a small marker that records that you are signed in so
              pages render correctly on first load.
            </li>
            <li>
              <strong>Your language.</strong> When you choose English or French we store that choice
              so the site opens in it next time.
            </li>
            <li>
              <strong>Your city and recent choices.</strong> Some preferences, such as the city you
              are browsing, are kept in your browser&apos;s own storage so you do not have to pick
              them again. They stay on your device.
            </li>
          </ul>
          <p>
            These are needed for the site to work. Blocking or clearing them will sign you out and
            reset your choices.
          </p>

          <h2>Removing them</h2>
          <p>
            Your browser can clear cookies and site data for this site at any time, from its privacy
            or site settings. Signing out clears the sign-in ones immediately.
          </p>

          <h2>More</h2>
          <p>
            The <Link href="/privacy">Privacy Policy</Link> explains what we collect and why, and
            the <Link href="/terms">Terms and Conditions</Link> cover your use of ETicketsGo.
          </p>
        </Prose>
        <OperatorLine />
      </LegalDocument>
    </>
  );
}
