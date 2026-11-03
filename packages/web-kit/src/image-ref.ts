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
 * that is still in flight (`complete` false) is left to `onError`.
 */
export function whenAlreadyFailed(onFail: () => void) {
  return (img: HTMLImageElement | null) => {
    if (img && img.complete && img.naturalWidth === 0 && (img.currentSrc || img.src)) onFail();
  };
}
