import { publicLegalEntity, publicOperatorSentence } from '@eticketsgo/shared-types';

/**
 * The end of every console page: which DeepTrics company an organizer is dealing with.
 *
 * Resolved from the organization's REGISTERED country, which is business data the organizer
 * gave us and the same signal the campaign footer and the platform invoice series use: an
 * organizer registered in India deals with the Indian company, one in the United States with
 * DeepTrics LLC. While the organization is loading, or for a country where we have no
 * company, the line names both, each where it operates. Never a guess from an IP address.
 */
export function OrganizerLegalFooter({ country }: { country?: string | null }) {
  const entity = publicLegalEntity(country);
  return (
    <footer
      data-testid="organizer-legal-footer"
      className="mt-12 border-t border-border pt-4 text-xs text-text-muted"
    >
      <p>
        &copy; {new Date().getFullYear()} ETicketsGo{entity ? `, ${entity.shortName}` : ''}.{' '}
        {publicOperatorSentence(country)}
      </p>
    </footer>
  );
}
