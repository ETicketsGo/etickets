import { describe, expect, it } from 'vitest';
import { ImageOutbox, type OutboxStore, type StoredUpload, type Uploader } from './image-outbox';
import { summarize } from './image-uploads';

/** A device's storage that outlives the "page": the same Map handed to a new outbox. */
function fakeStore(rows = new Map<string, StoredUpload>()): OutboxStore & {
  rows: Map<string, StoredUpload>;
} {
  return {
    rows,
    load: async (eventId) => [...rows.values()].filter((row) => row.eventId === eventId),
    put: async (record) => {
      rows.set(record.key, { ...record });
    },
    remove: async (key) => {
      rows.delete(key);
    },
  };
}

async function sha(blob: Blob) {
  const digest = await crypto.subtle.digest('SHA-256', await blob.arrayBuffer());
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * The API as the outbox sees it, keyed like the real one: a key it has seen answers with the
 * gallery and adds nothing. `failNext` refuses the next N uploads before they arrive.
 */
function fakeServer() {
  const gallery: { id: string; path: string; key: string }[] = [];
  const calls: string[] = [];
  const focal: { imageId: string; x: number; y: number }[] = [];
  let failNext = 0;
  let hold: Promise<void> | null = null;
  const uploader: Uploader = {
    async addImage(eventId, blob, key) {
      calls.push(key);
      if (hold) await hold;
      if (failNext > 0) {
        failNext -= 1;
        throw new Error('Server error.');
      }
      if (!gallery.some((image) => image.key === key)) {
        const id = `img-${gallery.length + 1}`;
        const v = (await sha(blob)).slice(0, 16);
        gallery.push({ id, key, path: `/public/events/${eventId}/images/${id}?v=${v}` });
      }
      return { images: gallery.map(({ id, path }) => ({ id, path })) };
    },
    async setFocalPoint(_eventId, imageId, point) {
      focal.push({ imageId, ...point });
    },
    describeError: (err) => (err instanceof Error ? err.message : 'Something went wrong.'),
  };
  return {
    uploader,
    gallery,
    calls,
    focal,
    failTimes: (n: number) => {
      failNext = n;
    },
    holdUploads: () => {
      let release!: () => void;
      hold = new Promise((resolve) => (release = resolve));
      return () => {
        hold = null;
        release();
      };
    },
  };
}

const picture = (text: string) => new Blob([text], { type: 'image/jpeg' });
const files = [
  { key: 'key-cover', blob: picture('cover'), focal: { x: 0.25, y: 0.75 } },
  { key: 'key-second', blob: picture('second') },
];

describe('the image outbox', () => {
  it('uploads every file in order, sets the cover crop, and leaves nothing on the device', async () => {
    const store = fakeStore();
    const server = fakeServer();
    const outbox = new ImageOutbox(store, server.uploader);
    const queue = await outbox.enqueue('ev-1', files);
    expect(summarize(queue).complete).toBe(true);
    expect(server.gallery.map((image) => image.key)).toEqual(['key-cover', 'key-second']);
    expect(server.focal).toEqual([{ imageId: 'img-1', x: 0.25, y: 0.75 }]);
    expect(store.rows.size).toBe(0);
  });

  it('keeps a file on the device BEFORE its upload starts', async () => {
    const store = fakeStore();
    const server = fakeServer();
    const release = server.holdUploads();
    const outbox = new ImageOutbox(store, server.uploader);
    const pending = outbox.enqueue('ev-1', files);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect([...store.rows.values()].map((row) => `${row.key}:${row.status}`)).toEqual([
      'key-cover:uploading',
      'key-second:waiting',
    ]);
    expect(outbox.busy()).toBe(true);
    release();
    await pending;
    expect(outbox.busy()).toBe(false);
  });

  it('a failed upload is kept with its reason, and Retry finishes the job with the same key', async () => {
    const store = fakeStore();
    const server = fakeServer();
    server.failTimes(1);
    const outbox = new ImageOutbox(store, server.uploader);
    const paused = await outbox.enqueue('ev-1', files);
    expect(paused.items.map((item) => item.status)).toEqual(['failed', 'waiting']);
    expect(paused.items[0].error).toBe('Server error.');
    // The second file never went up ahead of the cover.
    expect(server.gallery).toHaveLength(0);
    expect(store.rows.get('key-cover')?.status).toBe('failed');

    const finished = await outbox.retry('ev-1');
    expect(summarize(finished).complete).toBe(true);
    expect(server.calls).toEqual(['key-cover', 'key-cover', 'key-second']);
    expect(server.gallery.map((image) => image.key)).toEqual(['key-cover', 'key-second']);
  });

  it('after the page went away mid-upload, a new page sees the files and Retry does not duplicate', async () => {
    const rows = new Map<string, StoredUpload>();
    const server = fakeServer();
    // The first page: the cover's upload ARRIVES, but the page is gone before the answer.
    const deadPage: Uploader = {
      ...server.uploader,
      addImage: async (eventId, blob, key) => {
        await server.uploader.addImage(eventId, blob, key);
        return new Promise(() => undefined);
      },
    };
    const first = new ImageOutbox(fakeStore(rows), deadPage);
    void first.enqueue('ev-1', files);
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(server.gallery.map((image) => image.key)).toEqual(['key-cover']);
    expect([...rows.values()].map((row) => row.status)).toEqual(['uploading', 'waiting']);

    // The reload.
    const second = new ImageOutbox(fakeStore(rows), server.uploader);
    await second.load('ev-1');
    const restored = second.snapshot('ev-1')!;
    expect(restored.items.map((item) => item.status)).toEqual(['interrupted', 'waiting']);
    expect(second.blob('key-cover')).toBeDefined();

    const finished = await second.retry('ev-1');
    expect(summarize(finished).complete).toBe(true);
    // One image per picked file, though the cover was sent twice.
    expect(server.gallery.map((image) => image.key)).toEqual(['key-cover', 'key-second']);
    expect(rows.size).toBe(0);
  });

  it('handing the same files over twice (a double submit) uploads each once', async () => {
    const server = fakeServer();
    const outbox = new ImageOutbox(fakeStore(), server.uploader);
    await Promise.all([outbox.enqueue('ev-1', files), outbox.enqueue('ev-1', files)]);
    expect(server.calls).toEqual(['key-cover', 'key-second']);
  });

  it('removing a failed file lets the rest go up', async () => {
    const store = fakeStore();
    const server = fakeServer();
    server.failTimes(1);
    const outbox = new ImageOutbox(store, server.uploader);
    await outbox.enqueue('ev-1', files);
    await outbox.dismiss('ev-1', 'key-cover');
    await outbox.retry('ev-1');
    expect(server.gallery.map((image) => image.key)).toEqual(['key-second']);
    expect(store.rows.size).toBe(0);
  });

  it('still uploads when the device refuses to store anything', async () => {
    const server = fakeServer();
    const broken: OutboxStore = {
      load: async () => {
        throw new Error('blocked');
      },
      put: async () => {
        throw new Error('blocked');
      },
      remove: async () => {
        throw new Error('blocked');
      },
    };
    const outbox = new ImageOutbox(broken, server.uploader);
    const queue = await outbox.enqueue('ev-1', files);
    expect(summarize(queue).complete).toBe(true);
  });
});

describe('discarding what is left', () => {
  it('forgets every unfinished file without uploading the ones that were waiting', async () => {
    const store = fakeStore();
    const server = fakeServer();
    server.failTimes(1);
    const outbox = new ImageOutbox(store, server.uploader);
    await outbox.enqueue('ev-1', files);
    await outbox.dismissAll('ev-1');
    expect(server.calls).toEqual(['key-cover']);
    expect(outbox.snapshot('ev-1')?.items).toEqual([]);
    expect(store.rows.size).toBe(0);
  });
});
