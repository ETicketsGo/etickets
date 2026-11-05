'use client';

import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useCallback, useEffect, useRef, useState } from 'react';
import Cropper, { type Area } from 'react-easy-crop';
import { api, apiAssetUrl, Button, Dialog, useToast, errorMessage } from '@eticketsgo/web-kit';
import {
  ACCEPTED_TYPES,
  cropToFile,
  IMAGE_SPECS,
  sourceProblem,
  type ImageKind,
  type PixelArea,
} from './image-crop';

/**
 * The organization's profile picture and cover image.
 *
 * ── WHY THESE ARE UPLOADED AND CROPPED, NOT LINKED ─────────────────────────────────
 * The fields before them asked for a URL to an image hosted somewhere else. Most organizers
 * have nowhere to host one, the links that did arrive rotted, and a third-party URL rendered
 * under this platform's name is somebody else's server deciding what our customers see. The
 * platform holds the bytes, exactly as it does for event posters.
 *
 * ── WHY A CROP STEP ───────────────────────────────────────────────────────────────────
 * The public page showed the cover at a fixed 160px height, which on a wide screen is about
 * 7:1: a photo was cut to a thin strip and any lettering in it was enlarged and clipped. Every
 * surface now shows the cover at 3:1, and the organizer chooses that 3:1 here, with zoom and
 * position, seeing the exact result before it is saved. The picture is chosen inside a circle
 * because that is how every page shows it.
 *
 * What is shown is whatever `logoUrl` / `coverImageUrl` points at, so an organizer who pasted a
 * link years ago keeps working until they replace it.
 */
export function ProfilePicture({
  orgId,
  name,
  logoUrl,
  coverImageUrl,
}: {
  orgId: string;
  name: string;
  logoUrl?: string | null;
  coverImageUrl?: string | null;
}) {
  return (
    <div className="space-y-4">
      <OrgImage orgId={orgId} kind="cover" url={coverImageUrl} name={name} />
      <OrgImage orgId={orgId} kind="logo" url={logoUrl} name={name} />
    </div>
  );
}

const COPY: Record<
  ImageKind,
  {
    fileLabel: string;
    upload: string;
    replace: string;
    adjust: string;
    saved: string;
    removed: string;
    dialogTitle: string;
    limits: string;
  }
> = {
  logo: {
    fileLabel: 'Profile picture file',
    upload: 'Upload a picture',
    replace: 'Replace picture',
    adjust: 'Adjust picture',
    saved: 'Profile picture updated.',
    removed: 'Profile picture removed.',
    dialogTitle: 'Position your profile picture',
    limits:
      'JPG, PNG or WebP. Shown in a circle on your event pages, your public profile and in this console.',
  },
  cover: {
    fileLabel: 'Cover image file',
    upload: 'Upload a cover image',
    replace: 'Replace cover',
    adjust: 'Adjust cover',
    saved: 'Cover image updated.',
    removed: 'Cover image removed.',
    dialogTitle: 'Position your cover image',
    limits: 'JPG, PNG or WebP. Shown at 3:1 across the top of your public page.',
  },
};

function OrgImage({
  orgId,
  kind,
  url,
  name,
}: {
  orgId: string;
  kind: ImageKind;
  url?: string | null;
  name: string;
}) {
  const qc = useQueryClient();
  const toast = useToast();
  const copy = COPY[kind];
  const fileInput = useRef<HTMLInputElement>(null);
  const [preview, setPreview] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [source, setSource] = useState<{ src: string; type: string } | null>(null);
  const [opening, setOpening] = useState(false);

  // A stored picture changed (a save elsewhere, another organization): drop the local preview.
  useEffect(() => setPreview(null), [url]);
  const shown = preview ?? apiAssetUrl(url ?? null);

  const upload = useMutation({
    mutationFn: (file: File) =>
      kind === 'logo'
        ? api.organizations.uploadLogo(orgId, file, file.name)
        : api.organizations.uploadCover(orgId, file, file.name),
    onSuccess: () => {
      setProblem(null);
      toast.push(copy.saved, 'success');
      // The masthead and every card read the organization record, so refresh it. The settings
      // form keeps any unsaved typing: it reloads only while nobody has typed (see page.tsx).
      void qc.invalidateQueries({ queryKey: ['organizations'] });
    },
    onError: (e) => {
      setPreview(null);
      setProblem(`Not saved. ${errorMessage(e)}`);
      toast.push(errorMessage(e), 'error');
    },
  });

  const remove = useMutation({
    mutationFn: () =>
      kind === 'logo' ? api.organizations.removeLogo(orgId) : api.organizations.removeCover(orgId),
    onSuccess: () => {
      setPreview(null);
      setProblem(null);
      toast.push(copy.removed, 'success');
      void qc.invalidateQueries({ queryKey: ['organizations'] });
    },
    onError: (e) => toast.push(errorMessage(e), 'error'),
  });

  const closeCrop = () => {
    if (source) URL.revokeObjectURL(source.src);
    setSource(null);
  };

  /** Re-open the saved picture to change its framing. */
  const adjust = async () => {
    if (!shown) return;
    setOpening(true);
    try {
      const res = await fetch(shown, { mode: 'cors' });
      if (!res.ok) throw new Error();
      const blob = await res.blob();
      setSource({ src: URL.createObjectURL(blob), type: blob.type });
    } catch {
      setProblem('The saved image could not be opened for adjusting. Upload it again instead.');
    } finally {
      setOpening(false);
    }
  };

  const busy = upload.isPending || remove.isPending;
  const image = shown ? (
    // eslint-disable-next-line @next/next/no-img-element
    <img
      src={shown}
      alt={kind === 'logo' ? `${name} profile picture` : `${name} cover image`}
      data-testid={`org-${kind}-preview`}
      className={
        kind === 'logo'
          ? 'h-20 w-20 rounded-full border border-border object-cover'
          : 'aspect-[3/1] w-full rounded-md border border-border object-cover'
      }
    />
  ) : kind === 'logo' ? (
    <span
      aria-hidden
      className="flex h-20 w-20 items-center justify-center rounded-full bg-tint-primary text-h2 font-semibold text-action-primary"
    >
      {name.trim().charAt(0).toUpperCase()}
    </span>
  ) : (
    <div className="aspect-[3/1] w-full rounded-md border border-dashed border-border bg-background-subtle" />
  );

  return (
    <div className={kind === 'logo' ? 'flex flex-wrap items-center gap-4' : undefined}>
      {image}
      <div className={kind === 'logo' ? 'space-y-2' : 'mt-2 space-y-2'}>
        <input
          ref={fileInput}
          type="file"
          /*
            Visually hidden, because the button beside it is the control people use - but hidden
            is not unlabelled. Without this a screen reader announces "file upload" with no idea
            which picture it sets, and the accessibility sweep fails the route.
          */
          aria-label={copy.fileLabel}
          accept={ACCEPTED_TYPES.join(',')}
          className="sr-only"
          onChange={(e) => {
            const file = e.target.files?.[0];
            e.target.value = '';
            if (!file) return;
            const bad = sourceProblem(file);
            if (bad) {
              setProblem(bad);
              return;
            }
            setProblem(null);
            setSource({ src: URL.createObjectURL(file), type: file.type });
          }}
        />
        <div className="flex flex-wrap items-center gap-2">
          <Button
            variant="secondary"
            size="sm"
            loading={upload.isPending}
            disabled={busy}
            onClick={() => fileInput.current?.click()}
          >
            {shown ? copy.replace : copy.upload}
          </Button>
          {shown ? (
            <>
              <Button variant="ghost" size="sm" loading={opening} disabled={busy} onClick={adjust}>
                {copy.adjust}
              </Button>
              <Button
                variant="ghost"
                size="sm"
                loading={remove.isPending}
                disabled={busy}
                onClick={() => remove.mutate()}
              >
                Remove
              </Button>
            </>
          ) : null}
        </div>
        <p className="text-caption text-text-muted">{copy.limits}</p>
        {problem ? (
          <p role="alert" className="text-caption text-status-error">
            {problem}
          </p>
        ) : null}
      </div>
      {source ? (
        <CropDialog
          kind={kind}
          title={copy.dialogTitle}
          src={source.src}
          sourceType={source.type}
          onCancel={closeCrop}
          onDone={(file) => {
            closeCrop();
            // Shown at once, so a slow upload does not look like nothing happened.
            setPreview(URL.createObjectURL(file));
            upload.mutate(file);
          }}
        />
      ) : null}
    </div>
  );
}

const MIN_ZOOM = 1;
const MAX_ZOOM = 4;

/**
 * Choose the framing: drag (or use the arrow keys) to move, zoom with the slider, the buttons or
 * the mouse wheel. The preview beside it is exactly the area that will be saved.
 */
function CropDialog({
  kind,
  title,
  src,
  sourceType,
  onCancel,
  onDone,
}: {
  kind: ImageKind;
  title: string;
  src: string;
  sourceType: string;
  onCancel: () => void;
  onDone: (file: File) => void;
}) {
  const spec = IMAGE_SPECS[kind];
  const [crop, setCrop] = useState({ x: 0, y: 0 });
  const [zoom, setZoom] = useState(1);
  const [area, setArea] = useState<Area | null>(null);
  const [pixels, setPixels] = useState<PixelArea | null>(null);
  const [saving, setSaving] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const onCropComplete = useCallback((a: Area, p: Area) => {
    setArea(a);
    setPixels(p);
  }, []);
  const clampZoom = (z: number) => Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, Math.round(z * 10) / 10));
  /*
    The frame is the cropper's keyboard control (the arrow keys move the image) but the library
    gives it no name, so a screen reader announced an unlabelled group. Named once the image
    has loaded and the frame exists.
  */
  const cropBox = useRef<HTMLDivElement>(null);
  const framed = area !== null;
  useEffect(() => {
    // The frame exists once the first crop has been computed.
    const frame = cropBox.current?.querySelector('.reactEasyCrop_CropArea');
    frame?.setAttribute('role', 'group');
    frame?.setAttribute('aria-label', 'Image position. Use the arrow keys to move the image.');
  }, [framed]);

  const save = async () => {
    if (!pixels) return;
    setSaving(true);
    setProblem(null);
    try {
      onDone(await cropToFile(src, pixels, kind, sourceType));
    } catch (e) {
      setProblem(e instanceof Error ? e.message : 'The image could not be prepared.');
      setSaving(false);
    }
  };

  // The saved area, drawn the way the pages draw it: a circle for the picture, 3:1 for the cover.
  const scale = area ? 100 / area.width : 1;
  return (
    <Dialog
      open
      onClose={onCancel}
      title={title}
      description="Drag the image, or use the arrow keys, to move it. Zoom to fit what matters inside the frame."
      size="lg"
      footer={
        <div className="flex flex-wrap justify-end gap-2">
          <Button variant="ghost" onClick={onCancel} disabled={saving}>
            Cancel
          </Button>
          <Button onClick={save} loading={saving} disabled={!pixels} data-testid="crop-save">
            {kind === 'logo' ? 'Save picture' : 'Save cover'}
          </Button>
        </div>
      }
    >
      <div className="space-y-4">
        <div
          ref={cropBox}
          className="relative h-64 w-full overflow-hidden rounded-md bg-neutral-900 sm:h-80"
          data-testid="crop-area"
        >
          <Cropper
            image={src}
            crop={crop}
            zoom={zoom}
            minZoom={MIN_ZOOM}
            maxZoom={MAX_ZOOM}
            aspect={spec.aspect}
            cropShape={kind === 'logo' ? 'round' : 'rect'}
            showGrid={false}
            keyboardStep={10}
            onCropChange={setCrop}
            onZoomChange={(z) => setZoom(clampZoom(z))}
            onCropComplete={onCropComplete}
          />
        </div>
        <div className="flex items-center gap-3">
          <Button
            variant="secondary"
            size="sm"
            aria-label="Zoom out"
            onClick={() => setZoom((z) => clampZoom(z - 0.2))}
          >
            -
          </Button>
          <input
            type="range"
            aria-label="Zoom"
            min={MIN_ZOOM}
            max={MAX_ZOOM}
            step={0.1}
            value={zoom}
            onChange={(e) => setZoom(clampZoom(Number(e.target.value)))}
            className="w-full accent-action-primary"
            data-testid="crop-zoom"
          />
          <Button
            variant="secondary"
            size="sm"
            aria-label="Zoom in"
            onClick={() => setZoom((z) => clampZoom(z + 0.2))}
          >
            +
          </Button>
        </div>
        <div>
          <p className="mb-2 text-caption font-medium text-text-secondary">This is what is saved</p>
          <div
            data-testid="crop-preview"
            className={
              kind === 'logo'
                ? 'relative h-24 w-24 overflow-hidden rounded-full border border-border'
                : 'relative aspect-[3/1] w-full max-w-md overflow-hidden rounded-md border border-border'
            }
          >
            {area ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                src={src}
                alt=""
                className="absolute left-0 top-0 max-w-none origin-top-left"
                style={{
                  width: 'calc(100% + 0.5px)',
                  height: 'auto',
                  transform: `translate3d(${-area.x * scale}%, ${-area.y * scale}%, 0) scale3d(${scale}, ${scale}, 1)`,
                }}
              />
            ) : null}
          </div>
        </div>
        {problem ? (
          <p role="alert" className="text-caption text-status-error">
            {problem}
          </p>
        ) : null}
      </div>
    </Dialog>
  );
}
