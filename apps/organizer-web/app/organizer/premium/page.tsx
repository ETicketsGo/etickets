import { redirect } from 'next/navigation';

/**
 * "Premium & enterprise" was a list of build-time flags with a contact form, and said in its own
 * words that no per-organization entitlement model existed. Billing & plans replaces it with the
 * organization's real plan and entitlements. Kept as a redirect so old links and bookmarks land
 * on the page that answers the same question.
 */
export default function PremiumRedirect() {
  redirect('/organizer/billing');
}
