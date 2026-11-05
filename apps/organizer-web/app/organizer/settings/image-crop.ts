/**
 * Turning a picked photo and a crop into the file that is uploaded.
 *
 * Pure browser code with no React, so it can be read on its own: decode the image, draw the
 * chosen area onto a canvas at the size the picture is shown at, and encode it under the
 * upload limit. The crop is baked into the saved file, which is why every page that shows the
 * picture (the console, the public organizer page, the event page) shows the same framing
 * with no stored offsets to interpret.
 */

export interface PixelArea {
  x: number;
  y: number;
  width: number;
  height: number;
}

export type ImageKind = 'logo' | 'cover';

/** What each picture is cropped to, and the upload limit the API enforces for it. */
export const IMAGE_SPECS: Record<
  ImageKind,
  { aspect: number; outWidth: number; maxBytes: number; label: string }
> = {
  // Square, shown in a circle. 512px is sharp at the 80px it is shown at on a 3x screen.
  logo: { aspect: 1, outWidth: 512, maxBytes: 1_000_000, label: 'profile picture' },
  // 3:1 everywhere it is shown, so what is chosen here is what every page shows.
  cover: { aspect: 3, outWidth: 1800, maxBytes: 3_000_000, label: 'cover image' },
};

export const ACCEPTED_TYPES = ['image/jpeg', 'image/png', 'image/webp'] as const;
/** A photo larger than this is not something a browser should be asked to decode. */
const MAX_SOURCE_BYTES = 25_000_000;

/** Why this file cannot be used, or null. Checked before anything is decoded. */
export function sourceProblem(file: File): string | null {
  if (!(ACCEPTED_TYPES as readonly string[]).includes(file.type)) {
    return 'Use a JPG, PNG or WebP image.';
  }
  if (file.size > MAX_SOURCE_BYTES)
    return 'That file is too large to open. Use an image under 25 MB.';
  return null;
}

function load(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('This image could not be opened. Try another file.'));
    img.src = src;
  });
}

const encode = (canvas: HTMLCanvasElement, type: string, quality?: number) =>
  new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, type, quality));

/**
 * The cropped picture as an upload-ready file.
 *
 * Never upscaled: a small source keeps its own pixels rather than being blown up into blur.
 * PNG stays PNG (a logo's transparent corners matter); everything else is JPEG, stepped down in
 * quality and then in size until it fits the limit, so a large photo is not refused for size.
 */
export async function cropToFile(
  src: string,
  area: PixelArea,
  kind: ImageKind,
  sourceType: string,
): Promise<File> {
  const spec = IMAGE_SPECS[kind];
  const img = await load(src);
  const keepPng = sourceType === 'image/png';
  let width = Math.min(spec.outWidth, Math.round(area.width));
  for (let attempt = 0; attempt < 6; attempt++) {
    const height = Math.round(width / spec.aspect);
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('This browser cannot prepare the image.');
    ctx.imageSmoothingQuality = 'high';
    if (!keepPng) {
      // JPEG has no transparency: a transparent PNG area would otherwise turn black.
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0, 0, width, height);
    }
    ctx.drawImage(img, area.x, area.y, area.width, area.height, 0, 0, width, height);
    for (const quality of keepPng ? [undefined] : [0.9, 0.82, 0.72]) {
      const blob = await encode(canvas, keepPng ? 'image/png' : 'image/jpeg', quality);
      if (blob && blob.size <= spec.maxBytes) {
        return new File([blob], `${kind}.${keepPng ? 'png' : 'jpg'}`, { type: blob.type });
      }
    }
    width = Math.round(width * 0.75);
  }
  throw new Error(`The ${spec.label} is still too large after resizing. Try a smaller image.`);
}
