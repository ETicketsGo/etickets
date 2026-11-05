import jsQR from 'jsqr';

/**
 * Reading a ticket's QR code from the device camera.
 *
 * ── WHY THIS EXISTS ──────────────────────────────────────────────────────────────────
 * The door page required `window.BarcodeDetector`, which Chrome ships on Android, macOS and
 * ChromeOS but NOT on Windows or Linux desktops. So "Scan with camera" told an organizer in
 * desktop Chrome that the browser "does not support scanning" without ever asking for the
 * camera. Missing BarcodeDetector is not missing camera support: frames are now decoded with
 * jsQR when the native detector is absent or cannot read QR codes.
 */

/** Why the camera cannot be used, in words staff can act on, or null when it can be tried. */
export function cameraUnavailableReason(): string | null {
  if (typeof window === 'undefined') return 'The camera can only be used in a browser.';
  if (!window.isSecureContext) {
    return 'The camera only works on a secure (https) page. Open the check-in page over https, or use manual entry.';
  }
  if (!navigator.mediaDevices?.getUserMedia) {
    return 'This browser cannot open a camera. Use manual entry, or open this page in Chrome or Safari.';
  }
  return null;
}

/** A getUserMedia failure, told apart: refused, absent, busy or something else. */
export function cameraErrorMessage(err: unknown): string {
  const name = (err as { name?: string } | null)?.name ?? '';
  switch (name) {
    case 'NotAllowedError':
    case 'SecurityError':
      return 'Camera permission was refused. Allow camera access for this site in the browser settings, then try again.';
    case 'NotFoundError':
    case 'OverconstrainedError':
      return 'No camera was found on this device. Use manual entry.';
    case 'NotReadableError':
    case 'AbortError':
      return 'The camera is in use by another app or tab. Close it there and try again.';
    default:
      return 'The camera could not be started. Try again, or use manual entry.';
  }
}

/** Open a camera, preferring the one on the back; any camera when there is no back camera. */
export async function openCamera(): Promise<MediaStream> {
  try {
    return await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' } });
  } catch (err) {
    const name = (err as { name?: string }).name;
    // A laptop has no "environment" camera; ask for any camera rather than failing.
    if (name === 'OverconstrainedError' || name === 'NotFoundError') {
      return navigator.mediaDevices.getUserMedia({ video: true });
    }
    throw err;
  }
}

type Detect = (video: HTMLVideoElement) => Promise<string | null>;

/**
 * A QR reader for video frames: the browser's own detector when it reads QR codes, jsQR
 * otherwise. The choice is made once, when scanning starts.
 */
export async function createQrReader(): Promise<{ detect: Detect; engine: 'native' | 'jsqr' }> {
  const Native = (window as unknown as { BarcodeDetector?: BarcodeDetectorCtor }).BarcodeDetector;
  if (Native) {
    try {
      const formats = (await Native.getSupportedFormats?.()) ?? ['qr_code'];
      if (formats.includes('qr_code')) {
        const detector = new Native({ formats: ['qr_code'] });
        return {
          engine: 'native',
          detect: async (video) => (await detector.detect(video))[0]?.rawValue ?? null,
        };
      }
    } catch {
      /* fall through to jsQR */
    }
  }
  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  return {
    engine: 'jsqr',
    detect: async (video) => {
      if (!ctx || video.readyState < 2 || !video.videoWidth) return null;
      // Decoded at most 640px wide: plenty for a phone held to a ticket, and fast on a laptop.
      const scale = Math.min(1, 640 / video.videoWidth);
      canvas.width = Math.round(video.videoWidth * scale);
      canvas.height = Math.round(video.videoHeight * scale);
      ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
      const frame = ctx.getImageData(0, 0, canvas.width, canvas.height);
      return (
        jsQR(frame.data, frame.width, frame.height, { inversionAttempts: 'dontInvert' })?.data ??
        null
      );
    },
  };
}

interface BarcodeDetectorCtor {
  new (opts: { formats: string[] }): {
    detect(v: HTMLVideoElement): Promise<{ rawValue: string }[]>;
  };
  getSupportedFormats?: () => Promise<string[]>;
}

/** Ignore the same code read again within this many milliseconds (a held-up ticket). */
export const REPEAT_SCAN_WINDOW_MS = 3000;
