/**
 * What the event page's hero shows, given the images that have failed to load.
 *
 * ── WHY THIS EXISTS ────────────────────────────────────────────────────────────────
 * The hero trusted every image to load. When one did not - a file gone from storage, a 404, a
 * blocked request - the buyer saw a black box with the browser's broken-image icon, and the
 * thumbnails under it were broken icons too. The cards already fell back to a lettered gradient;
 * the event page, the most important place an image is shown, did not.
 *
 * ── WHY A FAILED IMAGE IS DROPPED, BUT THE BOX IS KEPT ─────────────────────────────
 * A failed image leaves the gallery: it is not shown, not offered as a thumbnail and not put in
 * the full-screen viewer. But the hero keeps the shape it had when the page arrived with images
 * ("placeholder"), because a failure is found only after the page has drawn - swapping the 16:9
 * box for the short no-image banner would move everything below it while the buyer reads.
 */

export type HeroMode = 'image' | 'placeholder' | 'none';

export interface HeroState<T> {
  /** Images still worth showing, in the organizer's order. */
  usable: T[];
  /** Index into `usable` of the image in the hero; 0 when there is none. */
  index: number;
  image: T | null;
  /**
   * `image`: show it. `placeholder`: the event had images and none loaded, so the image-shaped
   * box is filled with the branded gradient. `none`: the event never had an image.
   */
  mode: HeroMode;
}

export function heroState<T extends { full: string }>(
  gallery: readonly T[],
  failed: readonly string[],
  active: number,
): HeroState<T> {
  const usable = gallery.filter((image) => !failed.includes(image.full));
  const index = Math.min(Math.max(active, 0), Math.max(usable.length - 1, 0));
  const image = usable[index] ?? null;
  return {
    usable,
    index,
    image,
    mode: image ? 'image' : gallery.length > 0 ? 'placeholder' : 'none',
  };
}
