import { describe, expect, it } from 'vitest';
import {
  emptyQueue,
  imageIdForHash,
  nextUpload,
  statusWords,
  summarize,
  uploadReducer,
  type UploadAction,
  type UploadQueue,
} from './image-uploads';

const run = (actions: UploadAction[], from: UploadQueue = emptyQueue('ev-1')) =>
  actions.reduce(uploadReducer, from);
const statuses = (queue: UploadQueue) => queue.items.map((item) => `${item.key}:${item.status}`);

const three: UploadAction = {
  type: 'add',
  items: [{ key: 'a', focal: { x: 0.2, y: 0.3 } }, { key: 'b' }, { key: 'c' }],
};

describe('the image upload queue', () => {
  it('uploads in the order the organizer chose, one at a time', () => {
    let q = run([three]);
    expect(nextUpload(q)).toBe('a');
    q = uploadReducer(q, { type: 'start', key: 'a' });
    // Busy: nothing else may start while the head is going up.
    expect(nextUpload(q)).toBeNull();
    expect(uploadReducer(q, { type: 'start', key: 'b' })).toBe(q);
    q = run([{ type: 'succeed', key: 'a' }], q);
    expect(nextUpload(q)).toBe('b');
    expect(q.items[0].focal).toEqual({ x: 0.2, y: 0.3 });
  });

  it('a failure holds the files behind it, so a retry cannot change which one is the cover', () => {
    const q = run([
      three,
      { type: 'start', key: 'a' },
      { type: 'fail', key: 'a', error: 'Server error.' },
    ]);
    expect(statuses(q)).toEqual(['a:failed', 'b:waiting', 'c:waiting']);
    expect(nextUpload(q)).toBeNull();
    const s = summarize(q);
    expect(s.settled).toBe(true);
    expect(s.complete).toBe(false);
    expect(s.needsRetry).toBe(1);
    expect(statusWords(q.items[0])).toBe('Not uploaded: Server error.');
    expect(statusWords(q.items[1])).toBe('Waiting');
  });

  it('Retry puts the failed file back at the head of the line, keeping its key', () => {
    const q = run([
      three,
      { type: 'start', key: 'a' },
      { type: 'fail', key: 'a', error: 'Server error.' },
      { type: 'retry' },
    ]);
    expect(nextUpload(q)).toBe('a');
    const again = uploadReducer(q, { type: 'start', key: 'a' });
    expect(again.items[0]).toMatchObject({ key: 'a', status: 'uploading', attempts: 2 });
    expect(again.items[0].error).toBeUndefined();
  });

  it('a reload turns an upload in flight into "interrupted", never into done', () => {
    const q = run([
      three,
      { type: 'start', key: 'a' },
      { type: 'succeed', key: 'a' },
      { type: 'start', key: 'b' },
      { type: 'restore' },
    ]);
    expect(statuses(q)).toEqual(['a:done', 'b:interrupted', 'c:waiting']);
    expect(nextUpload(q)).toBeNull();
    expect(summarize(q).needsRetry).toBe(1);
    expect(statusWords(q.items[1])).toBe('Not uploaded: the upload was interrupted.');
    expect(nextUpload(uploadReducer(q, { type: 'retry' }))).toBe('b');
  });

  it('the same files handed over twice (a double submit) are queued once', () => {
    const q = run([three, three]);
    expect(q.items.map((item) => item.key)).toEqual(['a', 'b', 'c']);
    expect(uploadReducer(q, three)).toBe(q);
  });

  it('removing a failed file lets the ones behind it go; an uploading one cannot be removed', () => {
    let q = run([three, { type: 'start', key: 'a' }]);
    expect(uploadReducer(q, { type: 'dismiss', key: 'a' })).toEqual(q);
    q = run(
      [
        { type: 'fail', key: 'a', error: 'Too big.' },
        { type: 'dismiss', key: 'a' },
      ],
      q,
    );
    expect(statuses(q)).toEqual(['b:waiting', 'c:waiting']);
    expect(nextUpload(q)).toBe('b');
  });

  it('is complete only when every file is uploaded', () => {
    let q = run([three]);
    for (const key of ['a', 'b', 'c']) {
      expect(summarize(q).complete).toBe(false);
      q = run(
        [
          { type: 'start', key },
          { type: 'succeed', key },
        ],
        q,
      );
    }
    expect(summarize(q)).toMatchObject({ complete: true, settled: true, done: 3 });
  });

  it('success and failure only land on a file that is uploading', () => {
    const q = run([three]);
    expect(uploadReducer(q, { type: 'succeed', key: 'a' })).toEqual(q);
    expect(uploadReducer(q, { type: 'fail', key: 'a', error: 'x' })).toEqual(q);
  });
});

describe('finding the uploaded image by its bytes', () => {
  const images = [
    { id: 'old', path: '/public/events/e/images/old?v=aaaaaaaaaaaaaaaa' },
    { id: 'first-copy', path: '/public/events/e/images/first-copy?v=bbbbbbbbbbbbbbbb' },
    { id: 'second-copy', path: '/public/events/e/images/second-copy?v=bbbbbbbbbbbbbbbb' },
  ];

  it('is the newest image whose URL version is the hash prefix', () => {
    expect(imageIdForHash(images, `${'b'.repeat(16)}${'0'.repeat(48)}`)).toBe('second-copy');
    expect(imageIdForHash(images, 'a'.repeat(64))).toBe('old');
  });

  it('is nothing when no image has those bytes', () => {
    expect(imageIdForHash(images, 'c'.repeat(64))).toBeNull();
  });
});
