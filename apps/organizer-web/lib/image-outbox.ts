import type { FocalPoint } from '@eticketsgo/web-kit';
import {
  emptyQueue,
  imageIdForHash,
  nextUpload,
  summarize,
  uploadReducer,
  type UploadAction,
  type UploadQueue,
  type UploadStatus,
} from './image-uploads';

/**
 * Where a new event's images wait until the API has them, and the one thing that sends them.
 *
 * ── WHY OUTSIDE THE PAGE ───────────────────────────────────────────────────────────
 * The upload used to live in the wizard's click handler, so its progress died with the page.
 * This object belongs to the browser tab instead of to a component:
 *   - moving to another console page keeps uploading (the tab is still the same app), and the
 *     event's own page shows the same progress, because it reads the same queue;
 *   - reloading or closing the tab is warned about while a file is in flight (`beforeunload`);
 *   - and if the tab goes anyway, every file not yet saved is still in this device's IndexedDB
 *     - the picture itself, its place in line, why it failed - so the event's page can show it
 *     and offer Retry. A file leaves storage only once the API has it.
 *
 * Device-local on purpose: the bytes are the organizer's own resized photos, already on this
 * device; nothing new is stored on a server until it is uploaded.
 */

/** One file as kept on this device until it is uploaded. */
export interface StoredUpload {
  key: string;
  eventId: string;
  /** Its place in the organizer's order; the lowest is the cover. */
  index: number;
  blob: Blob;
  focal: FocalPoint | null;
  status: UploadStatus;
  error?: string;
}

export interface OutboxStore {
  load(eventId: string): Promise<StoredUpload[]>;
  put(record: StoredUpload): Promise<void>;
  remove(key: string): Promise<void>;
}

export interface Uploader {
  addImage(
    eventId: string,
    blob: Blob,
    key: string,
  ): Promise<{ images: { id: string; path: string }[] }>;
  setFocalPoint(eventId: string, imageId: string, point: FocalPoint): Promise<unknown>;
  describeError(err: unknown): string;
}

const CENTRE = { x: 0.5, y: 0.5 };

async function sha256Hex(blob: Blob): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', await blob.arrayBuffer());
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
}

export class ImageOutbox {
  private readonly queues = new Map<string, UploadQueue>();
  private readonly blobs = new Map<string, Blob>();
  private readonly loading = new Map<string, Promise<void>>();
  private readonly running = new Map<string, Promise<void>>();
  private readonly listeners = new Set<() => void>();

  constructor(
    private readonly store: OutboxStore,
    private readonly uploader: Uploader,
  ) {}

  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  /** The event's queue, or undefined when this device holds nothing for it. Stable until it changes. */
  snapshot(eventId: string): UploadQueue | undefined {
    return this.queues.get(eventId);
  }

  /** The picture a queued file is, for its thumbnail. */
  blob(key: string): Blob | undefined {
    return this.blobs.get(key);
  }

  /** Whether leaving the tab now would cut an upload short. */
  busy(): boolean {
    return this.running.size > 0;
  }

  /**
   * Reads what this device kept for the event, once per tab. Files that were uploading when the
   * last page went away come back as interrupted: whether they arrived is not known, and Retry
   * (with the same key) settles it either way.
   */
  load(eventId: string): Promise<void> {
    const pending = this.loading.get(eventId);
    if (pending) return pending;
    const task = (async () => {
      let stored: StoredUpload[] = [];
      try {
        stored = await this.store.load(eventId);
      } catch {
        // Storage refused (private window, cleared site data): there is nothing to restore.
      }
      if (stored.length === 0 || this.queues.has(eventId)) return;
      stored.sort((a, b) => a.index - b.index);
      for (const record of stored) this.blobs.set(record.key, record.blob);
      const queue: UploadQueue = {
        eventId,
        items: stored.map((record) => ({
          key: record.key,
          status: record.status,
          error: record.error,
          attempts: 0,
          focal: record.focal,
        })),
      };
      this.set(eventId, uploadReducer(queue, { type: 'restore' }));
    })();
    this.loading.set(eventId, task);
    return task;
  }

  /**
   * Hands the event's images over: kept on this device FIRST, then uploaded in order.
   * Resolves with the queue once it is finished or paused by a failure. Sending the same keys
   * again (a double submit) adds nothing and uploads nothing twice.
   */
  async enqueue(
    eventId: string,
    files: { key: string; blob: Blob; focal?: FocalPoint | null }[],
  ): Promise<UploadQueue> {
    await this.load(eventId);
    const before = this.queues.get(eventId) ?? emptyQueue(eventId);
    const known = new Set(before.items.map((item) => item.key));
    const fresh = files.filter((file) => !known.has(file.key));
    for (const [offset, file] of fresh.entries()) {
      this.blobs.set(file.key, file.blob);
      await this.persist({
        key: file.key,
        eventId,
        index: before.items.length + offset,
        blob: file.blob,
        focal: file.focal ?? null,
        status: 'waiting',
      });
    }
    this.dispatch(eventId, {
      type: 'add',
      items: fresh.map((file) => ({ key: file.key, focal: file.focal ?? null })),
    });
    return this.run(eventId);
  }

  /** Puts every failed or interrupted file back in line and resumes. */
  async retry(eventId: string): Promise<UploadQueue> {
    await this.load(eventId);
    this.dispatch(eventId, { type: 'retry' });
    return this.run(eventId);
  }

  /** Forgets one file the organizer no longer wants; the rest carry on. */
  async dismiss(eventId: string, key: string): Promise<void> {
    const queue = this.queues.get(eventId);
    if (!queue || queue.items.find((item) => item.key === key)?.status === 'uploading') return;
    this.dispatch(eventId, { type: 'dismiss', key });
    this.blobs.delete(key);
    await this.forget(key);
    // The files behind it were only waiting for it.
    if (nextUpload(this.queues.get(eventId)!)) void this.run(eventId);
  }

  /** Forgets every file not yet uploaded, without starting any of them on the way. */
  async dismissAll(eventId: string): Promise<void> {
    const queue = this.queues.get(eventId);
    if (!queue) return;
    for (const item of queue.items) {
      if (item.status === 'done' || item.status === 'uploading') continue;
      this.dispatch(eventId, { type: 'dismiss', key: item.key });
      this.blobs.delete(item.key);
      await this.forget(item.key);
    }
  }

  /** Drops the finished queue from memory once nobody needs to see it say "Uploaded". */
  clearDone(eventId: string) {
    const queue = this.queues.get(eventId);
    if (queue && summarize(queue).complete && !this.running.has(eventId)) {
      this.queues.delete(eventId);
      this.notify();
    }
  }

  /**
   * One runner per event; a second call waits for the one already going. Checked again after
   * it ends, so a Retry that lands just as a runner is finishing is not left waiting.
   */
  private async run(eventId: string): Promise<UploadQueue> {
    for (;;) {
      const already = this.running.get(eventId);
      if (already) {
        await already;
      } else {
        const task = this.drain(eventId).finally(() => {
          this.running.delete(eventId);
          this.notify();
        });
        this.running.set(eventId, task);
        this.notify();
        await task;
      }
      const queue = this.queues.get(eventId);
      if (!queue || !nextUpload(queue)) return queue ?? emptyQueue(eventId);
    }
  }

  private async drain(eventId: string) {
    for (;;) {
      const queue = this.queues.get(eventId);
      const key = queue ? nextUpload(queue) : null;
      if (!queue || !key) return;
      const blob = this.blobs.get(key);
      const item = queue.items.find((i) => i.key === key)!;
      this.dispatch(eventId, { type: 'start', key });
      await this.persistStatus(eventId, key, 'uploading');
      try {
        if (!blob) throw new Error('This picture is no longer on this device. Add it again.');
        const gallery = await this.uploader.addImage(eventId, blob, key);
        if (item.focal && (item.focal.x !== CENTRE.x || item.focal.y !== CENTRE.y)) {
          const imageId = imageIdForHash(gallery.images, await sha256Hex(blob));
          if (imageId) await this.uploader.setFocalPoint(eventId, imageId, item.focal);
        }
        this.dispatch(eventId, { type: 'succeed', key });
        this.blobs.delete(key);
        await this.forget(key);
      } catch (err) {
        const error = this.uploader.describeError(err);
        this.dispatch(eventId, { type: 'fail', key, error });
        await this.persistStatus(eventId, key, 'failed', error);
      }
    }
  }

  private dispatch(eventId: string, action: UploadAction) {
    const before = this.queues.get(eventId) ?? emptyQueue(eventId);
    const after = uploadReducer(before, action);
    if (after !== before) this.set(eventId, after);
  }

  private set(eventId: string, queue: UploadQueue) {
    this.queues.set(eventId, queue);
    this.notify();
  }

  private notify() {
    for (const listener of this.listeners) listener();
  }

  private async persistStatus(eventId: string, key: string, status: UploadStatus, error?: string) {
    const queue = this.queues.get(eventId);
    const index = queue?.items.findIndex((item) => item.key === key) ?? -1;
    const blob = this.blobs.get(key);
    if (!queue || index === -1 || !blob) return;
    await this.persist({
      key,
      eventId,
      index,
      blob,
      focal: queue.items[index].focal,
      status,
      error,
    });
  }

  // Storage is best effort: a browser that refuses it still uploads, it just cannot resume.
  private async persist(record: StoredUpload) {
    try {
      await this.store.put(record);
    } catch {
      /* see above */
    }
  }

  private async forget(key: string) {
    try {
      await this.store.remove(key);
    } catch {
      /* see above */
    }
  }
}

// ─── IndexedDB, and the one outbox per tab ───

const DB_NAME = 'eticketsgo-image-uploads';
const STORE = 'uploads';

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 1);
    request.onupgradeneeded = () => {
      const store = request.result.createObjectStore(STORE, { keyPath: 'key' });
      store.createIndex('eventId', 'eventId');
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function done<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

export function indexedDbStore(): OutboxStore {
  let db: Promise<IDBDatabase> | null = null;
  const store = async (mode: IDBTransactionMode) => {
    db ??= openDb();
    return (await db).transaction(STORE, mode).objectStore(STORE);
  };
  return {
    async load(eventId) {
      return done((await store('readonly')).index('eventId').getAll(eventId)) as Promise<
        StoredUpload[]
      >;
    },
    async put(record) {
      await done((await store('readwrite')).put(record));
    },
    async remove(key) {
      await done((await store('readwrite')).delete(key));
    },
  };
}

/** Holds nothing: for a browser with no IndexedDB, and for the server render. */
export const memoryStore: OutboxStore = {
  load: async () => [],
  put: async () => undefined,
  remove: async () => undefined,
};

let shared: ImageOutbox | null = null;

/**
 * The tab's one outbox. Created on first use in the browser, with the warning before the tab
 * is closed or reloaded while a file is still going up.
 */
export function imageOutbox(uploader: () => Uploader): ImageOutbox {
  if (shared) return shared;
  const browser = typeof window !== 'undefined';
  shared = new ImageOutbox(
    browser && typeof indexedDB !== 'undefined' ? indexedDbStore() : memoryStore,
    uploader(),
  );
  if (browser) {
    const outbox = shared;
    window.addEventListener('beforeunload', (event) => {
      if (!outbox.busy()) return;
      event.preventDefault();
      // Older browsers show the prompt only when this is set.
      event.returnValue = '';
    });
  }
  return shared;
}
