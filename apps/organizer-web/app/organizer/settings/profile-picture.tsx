'use client';

import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useRef, useState } from 'react';
import { api, apiAssetUrl, Button, useToast, errorMessage } from '@eticketsgo/web-kit';

/**
 * The organization's profile picture.
 *
 * ── WHY THIS REPLACED A URL BOX ────────────────────────────────────────────────────
 * The field before it asked for "Logo URL" and a link to an image hosted somewhere else.
 * Most organizers have nowhere to host one, so the field stayed empty and their events
 * showed an initial in a circle; the links that did arrive rotted, and a third-party URL
 * rendered under this platform's name is somebody else's server deciding what our customers
 * see. The platform holds the bytes now, exactly as it does for event posters.
 *
 * What is shown here is whatever `logoUrl` points at, which keeps an organizer who pasted a
 * link years ago working until they replace it.
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
  const qc = useQueryClient();
  const toast = useToast();
  const fileInput = useRef<HTMLInputElement>(null);
  const [preview, setPreview] = useState<string | null>(null);

  const shown = preview ?? apiAssetUrl(logoUrl ?? null);

  const upload = useMutation({
    mutationFn: (file: File) => api.organizations.uploadLogo(orgId, file, file.name),
    onSuccess: () => {
      toast.push('Profile picture updated.', 'success');
      // The masthead and every card read the organization record, so refresh it rather than
      // leaving the old picture on screen until the next navigation.
      void qc.invalidateQueries({ queryKey: ['organizations'] });
    },
    onError: (e) => {
      setPreview(null);
      toast.push(errorMessage(e), 'error');
    },
  });

  const remove = useMutation({
    mutationFn: () => api.organizations.removeLogo(orgId),
    onSuccess: () => {
      setPreview(null);
      toast.push('Profile picture removed.', 'success');
      void qc.invalidateQueries({ queryKey: ['organizations'] });
    },
    onError: (e) => toast.push(errorMessage(e), 'error'),
  });

  return (
    <div className="space-y-4">
      <CoverImage orgId={orgId} coverImageUrl={coverImageUrl} />
      <div className="flex flex-wrap items-center gap-4">
        {shown ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={shown}
            alt=""
            className="h-20 w-20 rounded-full border border-border object-cover"
          />
        ) : (
          <span
            aria-hidden
            className="flex h-20 w-20 items-center justify-center rounded-full bg-tint-primary text-h2 font-semibold text-action-primary"
          >
            {name.trim().charAt(0).toUpperCase()}
          </span>
        )}

        <div className="space-y-2">
          <input
            ref={fileInput}
            type="file"
            /*
            Visually hidden, because the button beside it is the control people use - but
            hidden is not unlabelled. Without this a screen reader announces "file upload"
            with no idea which picture it sets, and the accessibility sweep fails the route.
          */
            aria-label="Profile picture file"
            accept="image/jpeg,image/png,image/webp"
            className="sr-only"
            onChange={(e) => {
              const file = e.target.files?.[0];
              e.target.value = '';
              if (!file) return;
              // Shown immediately, so a slow upload does not look like nothing happened.
              setPreview(URL.createObjectURL(file));
              upload.mutate(file);
            }}
          />
          <div className="flex flex-wrap gap-2">
            <Button
              variant="secondary"
              size="sm"
              loading={upload.isPending}
              onClick={() => fileInput.current?.click()}
            >
              {shown ? 'Replace picture' : 'Upload a picture'}
            </Button>
            {shown ? (
              <Button
                variant="ghost"
                size="sm"
                loading={remove.isPending}
                onClick={() => remove.mutate()}
              >
                Remove
              </Button>
            ) : null}
          </div>
          <p className="text-caption text-text-muted">
            JPG, PNG or WebP, up to 1 MB. Shown on your event pages, your public profile and in this
            console.
          </p>
        </div>
      </div>
    </div>
  );
}

/**
 * The banner across the top of the public organizer page.
 *
 * Same decision as the picture, for the same reason: the field before it asked for a URL to
 * an image hosted somewhere else, and an organizer who had nowhere to host one simply had no
 * banner. Wider and a little larger, because it is a landscape image rather than an avatar.
 */
function CoverImage({ orgId, coverImageUrl }: { orgId: string; coverImageUrl?: string | null }) {
  const qc = useQueryClient();
  const toast = useToast();
  const fileInput = useRef<HTMLInputElement>(null);
  const [preview, setPreview] = useState<string | null>(null);
  const shown = preview ?? apiAssetUrl(coverImageUrl ?? null);

  const upload = useMutation({
    mutationFn: (file: File) => api.organizations.uploadCover(orgId, file, file.name),
    onSuccess: () => {
      toast.push('Cover image updated.', 'success');
      void qc.invalidateQueries({ queryKey: ['organizations'] });
    },
    onError: (e) => {
      setPreview(null);
      toast.push(errorMessage(e), 'error');
    },
  });

  const remove = useMutation({
    mutationFn: () => api.organizations.removeCover(orgId),
    onSuccess: () => {
      setPreview(null);
      toast.push('Cover image removed.', 'success');
      void qc.invalidateQueries({ queryKey: ['organizations'] });
    },
    onError: (e) => toast.push(errorMessage(e), 'error'),
  });

  return (
    <div>
      {shown ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={shown}
          alt=""
          className="h-28 w-full rounded-md border border-border object-cover"
        />
      ) : (
        <div className="h-28 w-full rounded-md border border-dashed border-border bg-gradient-to-br from-action-primary/20 via-action-primary/5 to-background-subtle" />
      )}
      <input
        ref={fileInput}
        type="file"
        aria-label="Cover image file"
        accept="image/jpeg,image/png,image/webp"
        className="sr-only"
        onChange={(e) => {
          const file = e.target.files?.[0];
          e.target.value = '';
          if (!file) return;
          setPreview(URL.createObjectURL(file));
          upload.mutate(file);
        }}
      />
      <div className="mt-2 flex flex-wrap items-center gap-2">
        <Button
          variant="secondary"
          size="sm"
          loading={upload.isPending}
          onClick={() => fileInput.current?.click()}
        >
          {shown ? 'Replace cover' : 'Upload a cover image'}
        </Button>
        {shown ? (
          <Button
            variant="ghost"
            size="sm"
            loading={remove.isPending}
            onClick={() => remove.mutate()}
          >
            Remove
          </Button>
        ) : null}
        <p className="text-caption text-text-muted">Wide image, up to 3 MB.</p>
      </div>
    </div>
  );
}
