import type { Metadata } from 'next';
import { PageHero, Prose } from '@/components/marketing/blocks';
import { Link } from '@/i18n/navigation';
import { LegalDocument, BackToLegal } from '@/components/legal/policy-chrome';
import { BrandPage } from '@/components/storefront-brand';

/**
 * How to delete an ETicketsGo account: in the app, or by asking from the website.
 *
 * Google Play requires a public web page where a person can ask for their account and its
 * data to be deleted, as well as the option inside the app. The facts here are the ones the
 * app's own deletion screen states (apps/customer-mobile/app/account/delete.tsx) and the API
 * applies (users/account-deletion.service.ts): signed out everywhere, tickets still valid,
 * purchase records kept for tax with the name and email removed.
 */
export const metadata: Metadata = {
  title: 'Delete your account',
  description: 'How to delete your ETicketsGo account and what happens to your data.',
  alternates: { canonical: '/delete-account' },
};

export default function DeleteAccountPage() {
  return (
    <BrandPage>
      <PageHero
        eyebrow="Your account"
        title="Delete your account"
        lead="You can delete your ETicketsGo account at any time."
      />
      <LegalDocument>
        <BackToLegal />
        <Prose>
          <h2>In the ETicketsGo app</h2>
          <ol>
            <li>Open the app and sign in.</li>
            <li>Go to Account, then Delete account.</li>
            <li>Type the confirmation words and confirm.</li>
          </ol>
          <h2>Without the app</h2>
          <p>
            Send us a request from the <Link href="/contact">contact page</Link>. Use the email
            address of your account and write &quot;Delete my account&quot;. We reply to that
            address to confirm, and then delete the account.
          </p>
          <h2>What happens</h2>
          <ul>
            <li>You are signed out on every device at once.</li>
            <li>
              Tickets you already bought stay valid. Deleting the account does not cancel or refund
              them, so keep your confirmation email: it is what gets you in.
            </li>
            <li>Your name, email, phone number and preferences are removed.</li>
            <li>
              The record of each purchase is kept for tax and dispute purposes, with your name and
              email removed from it.
            </li>
            <li>Notifications to your devices stop.</li>
          </ul>
          <p>
            For more about the data we keep, read the <Link href="/privacy">privacy policy</Link>.
          </p>
        </Prose>
      </LegalDocument>
    </BrandPage>
  );
}
