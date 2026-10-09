import { Badge, adminContact } from '@eticketsgo/web-kit';

/**
 * Where an email address would go on an admin screen.
 *
 * A phone-only account is stored with a placeholder address, and admin lists read stored rows,
 * so that placeholder reached these screens looking like any other address. It is shown here as
 * the phone number it stands for, labelled, because a bare number where an email is expected
 * reads as a data error, and the placeholder reads as an address somebody could write to.
 */
export function AccountContact({
  email,
  phone,
  fallback = null,
  className = 'text-caption text-text-secondary',
}: {
  email: string | null | undefined;
  /** The account's stored number, where the response has it. */
  phone?: string | null;
  /** What to show when there is no contact at all. */
  fallback?: string | null;
  className?: string;
}) {
  const contact = adminContact(email, phone);
  if (!contact) return fallback ? <span className={className}>{fallback}</span> : null;
  if (!contact.phoneSignIn) return <span className={`break-all ${className}`}>{contact.text}</span>;
  return (
    <span className={`inline-flex flex-wrap items-center gap-1.5 ${className}`}>
      <span className="whitespace-nowrap tabular-nums">{contact.text}</span>
      <Badge tone="neutral">Phone sign-in</Badge>
    </span>
  );
}

/**
 * The same, as plain text, for places that take a string: "+1 469-588-4580 (phone sign-in)".
 * Null when there is no honest contact to show.
 */
export function accountContactText(
  email: string | null | undefined,
  phone?: string | null,
): string | null {
  const contact = adminContact(email, phone);
  if (!contact) return null;
  return contact.phoneSignIn ? `${contact.text} (phone sign-in)` : contact.text;
}
