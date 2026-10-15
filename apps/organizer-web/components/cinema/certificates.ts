/**
 * Film certificates an organizer can choose.
 *
 * The CBFC's classes since 2024: U, UA 7+, UA 13+, UA 16+, A and S. The form offered the older
 * U, U/A, A and S, so a film rated UA 13+ could not be described truthfully, while the
 * storefront already showed "UA13+" for films that came from elsewhere.
 */
export const CERTIFICATES = ['U', 'UA 7+', 'UA 13+', 'UA 16+', 'A', 'S'] as const;

/**
 * The options for one film: the standard list, plus whatever the film already carries when it
 * is something else ("U/A" from before, "UA" from an import), so opening the form never changes
 * a film's certificate behind the organizer's back.
 */
export function certificateOptions(current: string | null | undefined): string[] {
  const list: string[] = [...CERTIFICATES];
  if (current && !list.includes(current)) list.unshift(current);
  return list;
}
