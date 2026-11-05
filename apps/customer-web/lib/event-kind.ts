/**
 * What kind of event this is, in the words a buyer should read: the organizer's own event type
 * when they chose "Other event type" (a poetry reading, a book swap), otherwise the category.
 * Browsing and filters still use `category`, where every typed type is listed as Other.
 */
export function eventKind(event: { category: string; typeLabel?: string | null }): string {
  return event.typeLabel?.trim() || event.category;
}
