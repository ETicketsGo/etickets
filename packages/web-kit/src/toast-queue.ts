/**
 * The toast list, kept pure so it is tested without a browser.
 *
 * ── ONE MESSAGE, ONE TOAST ───────────────────────────────────────────────────────────
 * A refused save that the admin tries again, or a failure reported by two handlers, pushed the
 * same sentence once per attempt, and the screen filled with copies of one error (reported on
 * the fee bands screen). A message that is already on screen with the same tone is not added
 * again; the caller restarts its timer instead, so it stays as long as the latest attempt.
 */
export interface QueuedToast<Tone extends string = string> {
  id: number;
  message: string;
  tone: Tone;
}

/** The list after `next` is pushed, and the id that now shows it (new, or the existing one). */
export function pushToast<Tone extends string>(
  list: readonly QueuedToast<Tone>[],
  next: QueuedToast<Tone>,
): { list: QueuedToast<Tone>[]; id: number; duplicate: boolean } {
  const same = list.find((t) => t.message === next.message && t.tone === next.tone);
  if (same) return { list: [...list], id: same.id, duplicate: true };
  return { list: [...list, next], id: next.id, duplicate: false };
}
