/**
 * An `<img>` ref that reports a picture which had ALREADY failed before React was listening.
 *
 * A server-rendered image starts loading with the HTML. If it fails before the page hydrates,
 * the browser fires `error` while no `onError` handler is attached yet, and React never hears of
 * it: the broken-image icon stays on screen where the fallback should be. Found when the
 * storefront began rendering event pages on the server - the "every image failing shows the
 * placeholder" journey regressed.
 *
 * Pass the same callback as `onError`: `ref={whenAlreadyFailed(fail)} onError={fail}`. A load
 * still in flight is left to `onError`. A picture that only LOOKS empty at this instant (complete,
 * no width yet) is confirmed with `decode()` before anything is taken down: a working picture
 * must never be swapped for the placeholder.
 */
export function whenAlreadyFailed(onFail: () => void) {
  return (img: HTMLImageElement | null) => {
    if (!img || !img.complete || img.naturalWidth > 0 || !(img.currentSrc || img.src)) return;
    if (typeof img.decode !== 'function') return;
    img.decode().then(
      () => undefined,
      () => {
        if (img.naturalWidth === 0) onFail();
      },
    );
  };
}
