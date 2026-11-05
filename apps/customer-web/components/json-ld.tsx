import { serializeJsonLd } from '@/lib/structured-data';

/**
 * A schema.org block, rendered on the server so a crawler reads it without running any
 * script. The content is escaped by `serializeJsonLd`; nothing else is ever put inside.
 */
export function JsonLd({ data }: { data: unknown }) {
  return (
    <script
      type="application/ld+json"
      // Escaped JSON only; see serializeJsonLd.
      dangerouslySetInnerHTML={{ __html: serializeJsonLd(data) }}
    />
  );
}
