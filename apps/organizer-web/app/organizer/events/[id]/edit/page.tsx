'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useParams } from 'next/navigation';
import { useEffect, useRef, useState } from 'react';
import {
  api,
  apiAssetUrl,
  Button,
  Card,
  Input,
  Select,
  Textarea,
  Skeleton,
  ErrorState,
  useToast,
  errorMessage,
} from '@eticketsgo/web-kit';
import { EVENT_CATEGORIES, isListedCategory } from '@/lib/templates';
import {
  EVENT_IMAGE_MAX_COUNT,
  EventGalleryEditor,
  prepareEventImage,
  type GalleryTile,
} from '@/components/event-image-picker';

const EDITABLE = ['DRAFT', 'UNDER_REVIEW', 'PAUSED'];
/*
  Images follow a looser rule than the fields above: they can change while the event is live,
  because a picture is not part of what a buyer agreed to. Only a finished event is locked.
*/
const IMAGES_LOCKED = ['CANCELLED', 'COMPLETED', 'ARCHIVED'];
const FEE_MODES = ['CUSTOMER_PAYS', 'ORGANIZER_PAYS', 'SHARED'];

export default function EditEvent() {
  const { id } = useParams<{ id: string }>();
  const qc = useQueryClient();
  const toast = useToast();
  const {
    data: event,
    isLoading,
    isError,
    refetch,
  } = useQuery({
    queryKey: ['event', id],
    queryFn: () => api.events.get(id),
  });

  const [form, setForm] = useState({
    title: '',
    category: '',
    description: '',
    refundPolicy: '',
    feeMode: 'CUSTOMER_PAYS',
    isFree: false,
  });
  /* Typed rather than picked, when the stored value is not one of the offered options. */
  const [categoryMode, setCategoryMode] = useState<'list' | 'other'>('list');

  useEffect(() => {
    if (event)
      setForm({
        title: event.title,
        category: event.category,
        description: event.description ?? '',
        refundPolicy: event.refundPolicy ?? '',
        feeMode: event.feeMode,
        isFree: event.isFree,
      });
    if (event) setCategoryMode(isListedCategory(event.category) ? 'list' : 'other');
  }, [event]);

  const save = useMutation({
    mutationFn: () =>
      api.events.update(id, {
        title: form.title,
        category: form.category,
        description: form.description || undefined,
        refundPolicy: form.refundPolicy || undefined,
        feeMode: form.feeMode,
        isFree: form.isFree,
      }),
    onSuccess: () => {
      toast.push('Event updated.', 'success');
      qc.invalidateQueries({ queryKey: ['event', id] });
    },
    onError: (e) => toast.push(errorMessage(e), 'error'),
  });

  /*
    Images save on their own, the moment they change — they are not part of "Save changes".

    Each picked file shows as a tile at once, from the organizer's own copy, marked uploading.
    Uploads run one after another through a single queue — also across separate picks — so
    images land in the order they were chosen. A saved image replaces its tile only after the
    event has been read back, so the picture never blinks out between the two; a refused one
    keeps its tile with the reason until it is dismissed.
  */
  const [imageError, setImageError] = useState<string | null>(null);
  const [pending, setPending] = useState<GalleryTile[]>([]);
  const nextKey = useRef(0);
  const queue = useRef<Promise<void>>(Promise.resolve());
  const objectUrls = useRef(new Set<string>());
  const refreshEvent = () => qc.invalidateQueries({ queryKey: ['event', id] });

  // Release the local previews when the organizer leaves the page.
  useEffect(() => {
    const urls = objectUrls.current;
    return () => urls.forEach((url) => URL.revokeObjectURL(url));
  }, []);

  const preview = (file: File) => {
    const url = URL.createObjectURL(file);
    objectUrls.current.add(url);
    return url;
  };
  const release = (url: string) => {
    URL.revokeObjectURL(url);
    objectUrls.current.delete(url);
  };
  const markFailed = (key: string, error: string) =>
    setPending((tiles) =>
      tiles.map((tile) => (tile.key === key ? { ...tile, status: 'failed', error } : tile)),
    );

  const addImages = (files: File[]) => {
    setImageError(null);
    const room = Math.max(
      0,
      EVENT_IMAGE_MAX_COUNT -
        (event?.images?.length ?? 0) -
        pending.filter((tile) => tile.status === 'uploading').length,
    );
    const batch = files.map((file, i) => ({
      file,
      tile: {
        key: `pending-${++nextKey.current}`,
        url: preview(file),
        ...(i < room
          ? { status: 'uploading' as const }
          : {
              status: 'failed' as const,
              error: `An event can have up to ${EVENT_IMAGE_MAX_COUNT} images.`,
            }),
      },
    }));
    setPending((tiles) => [...tiles, ...batch.map((b) => b.tile)]);

    queue.current = queue.current.then(async () => {
      let saved = 0;
      for (const { file, tile } of batch) {
        if (tile.status !== 'uploading') continue;
        try {
          await api.events.addImage(id, await prepareEventImage(file));
          await refreshEvent();
          saved += 1;
          setPending((tiles) => tiles.filter((t) => t.key !== tile.key));
          release(tile.url);
        } catch (err) {
          markFailed(tile.key, errorMessage(err));
        }
      }
      if (saved > 0) {
        toast.push(saved === 1 ? 'Image added.' : `${saved} images added.`, 'success');
      }
    });
  };

  const uploadingCount = pending.filter((tile) => tile.status === 'uploading').length;
  const removeImage = useMutation({
    mutationFn: (imageId: string) => api.events.removeImage(id, imageId),
    onSuccess: () => {
      setImageError(null);
      toast.push('Image removed.', 'success');
    },
    onError: (e) => setImageError(errorMessage(e)),
    onSettled: refreshEvent,
  });
  const reorderImages = useMutation({
    mutationFn: (imageIds: string[]) => api.events.reorderImages(id, imageIds),
    onSuccess: () => setImageError(null),
    onError: (e) => setImageError(errorMessage(e)),
    onSettled: refreshEvent,
  });

  if (isError)
    return (
      <ErrorState message="We couldn't load this. Please try again." onRetry={() => refetch()} />
    );
  if (isLoading || !event) return <Skeleton className="h-64 w-full" />;
  const editable = EDITABLE.includes(event.status);
  const hasBookings = event.sessions.some((sess) =>
    (sess.ticketTypes ?? []).some((t) => (t.inventory?.quantitySold ?? 0) > 0),
  );

  return (
    <Card className="max-w-2xl">
      {!editable && (
        <p className="mb-4 rounded-md bg-status-warning/10 p-3 text-sm text-status-warning">
          This event is {event.status.toLowerCase()} and cannot be edited. Pause it first to make
          changes.
        </p>
      )}
      <div className="space-y-4">
        <Input
          id="title"
          label="Title"
          value={form.title}
          onChange={(e) => setForm({ ...form, title: e.target.value })}
          disabled={!editable}
        />
        <Select
          id="category"
          label="Category"
          value={categoryMode === 'other' ? '__other' : form.category}
          disabled={!editable}
          onChange={(e) => {
            if (e.target.value === '__other') {
              setCategoryMode('other');
              setForm((f) => ({ ...f, category: '' }));
            } else {
              setCategoryMode('list');
              setForm((f) => ({ ...f, category: e.target.value }));
            }
          }}
        >
          <option value="">Select a category…</option>
          {EVENT_CATEGORIES.map((c) => (
            <option key={c} value={c}>
              {c}
            </option>
          ))}
          <option value="__other">Something else…</option>
        </Select>
        {categoryMode === 'other' && (
          <Input
            id="category-other"
            label="Your category"
            value={form.category}
            onChange={(e) => setForm({ ...form, category: e.target.value })}
            disabled={!editable}
          />
        )}
        <Textarea
          id="desc"
          label="Description"
          rows={4}
          value={form.description}
          onChange={(e) => setForm({ ...form, description: e.target.value })}
          disabled={!editable}
        />
        <EventGalleryEditor
          tiles={[
            ...(event.images ?? []).map((image) => ({
              key: image.id,
              url: apiAssetUrl(image.path) ?? '',
            })),
            ...pending,
          ]}
          disabled={IMAGES_LOCKED.includes(event.status)}
          // Order and removal wait for uploads, so a reorder never names a half-saved list.
          busy={uploadingCount > 0 || removeImage.isPending || reorderImages.isPending}
          error={imageError}
          note={
            IMAGES_LOCKED.includes(event.status)
              ? `This event is ${event.status.toLowerCase()}, so its images can no longer be changed.`
              : !editable
                ? 'Images can be changed while the event is live; the other fields need it paused.'
                : null
          }
          onAdd={addImages}
          onRemove={(key) => {
            const failed = pending.find((tile) => tile.key === key);
            if (failed) {
              setPending((tiles) => tiles.filter((tile) => tile.key !== key));
              release(failed.url);
            } else {
              removeImage.mutate(key);
            }
          }}
          onReorder={(imageIds) => reorderImages.mutate(imageIds)}
        />
        <Textarea
          id="refund"
          label="Refund policy"
          rows={2}
          value={form.refundPolicy}
          onChange={(e) => setForm({ ...form, refundPolicy: e.target.value })}
          disabled={!editable}
        />
        {/*
          Switching between free and paid is refused by the API once anybody has booked, so
          the control is disabled with the reason rather than left to fail on save. A
          confirmed booking with no payment behind it cannot be re-read as a paid one.
        */}
        <label className="flex items-start gap-3 rounded-md border border-border p-3">
          <input
            id="is-free"
            type="checkbox"
            className="mt-1 h-4 w-4"
            checked={form.isFree}
            disabled={!editable || hasBookings}
            onChange={(e) => setForm({ ...form, isFree: e.target.checked })}
          />
          <span className="text-sm">
            <span className="font-medium">This is a free event</span>
            <span className="mt-1 block text-text-muted">
              {hasBookings
                ? 'This event already has bookings, so it can no longer be switched between free and paid.'
                : 'Nobody is charged, so there is no checkout, no booking fee and no platform share. Attendees still book, get tickets and QR codes, and can cancel.'}
            </span>
          </span>
        </label>
        {!form.isFree && (
          <Select
            id="fee"
            label="Fee handling"
            value={form.feeMode}
            onChange={(e) => setForm({ ...form, feeMode: e.target.value })}
            disabled={!editable}
          >
            {FEE_MODES.map((f) => (
              <option key={f} value={f}>
                {f.replaceAll('_', ' ')}
              </option>
            ))}
          </Select>
        )}
        <Button loading={save.isPending} disabled={!editable} onClick={() => save.mutate()}>
          Save changes
        </Button>
      </div>
    </Card>
  );
}
