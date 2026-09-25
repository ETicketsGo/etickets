import { ObjectStoreService } from './object-store.service';
import type { ObjectStore } from './object-store.interface';

/**
 * Which copy of an object a read gets.
 *
 * ── THE CASE THAT MATTERS IS THE MIXED ONE ─────────────────────────────────────────
 * During a backfill both answers are live at once: a poster uploaded last week has its bytes
 * in Postgres, one uploaded after the switch has a key into R2, and every page renders some of
 * each. That state lasts for as long as the backfill takes, which is longer than anybody
 * plans for, so it is the state these tests are mostly about.
 */
function store(over: Partial<ObjectStore> = {}): ObjectStore {
  return {
    name: 'r2',
    put: jest.fn(async () => undefined),
    get: jest.fn(async () => null),
    delete: jest.fn(async () => undefined),
    publicUrl: () => null,
    health: async () => ({ healthy: true }),
    ...over,
  } as ObjectStore;
}

const IN_DATABASE = {
  bytes: Uint8Array.from([1, 2, 3]),
  storageKey: null,
  contentType: 'image/png',
};
const IN_BUCKET = {
  bytes: null,
  storageKey: 'public/events/ev1/abc.png',
  contentType: 'image/png',
};

describe('ObjectStoreService.read', () => {
  it('serves a row that holds its own bytes without touching the store', async () => {
    // The row decides, not the configuration. This is what makes switching the driver on safe:
    // every image uploaded before the switch keeps working, untouched, immediately after it.
    const s = store();
    const service = new ObjectStoreService(s);

    const out = await service.read(IN_DATABASE);

    expect(out?.body).toEqual(Buffer.from([1, 2, 3]));
    expect(out?.contentType).toBe('image/png');
    expect(s.get).not.toHaveBeenCalled();
  });

  it('fetches a row that points at an object', async () => {
    const s = store({
      get: jest.fn(async () => ({
        body: Buffer.from([9]),
        contentType: 'image/webp',
        sizeBytes: 1,
      })),
    });

    const out = await new ObjectStoreService(s).read(IN_BUCKET);

    expect(s.get).toHaveBeenCalledWith('public/events/ev1/abc.png');
    expect(out?.body).toEqual(Buffer.from([9]));
  });

  it('answers null when a row points at an object the store does not have', async () => {
    /*
      A bucket emptied by hand, a key written by a backfill that was rolled back. The caller
      turns this into a 404, which is the truth. Inventing a placeholder here would hide a
      data-loss incident behind a grey rectangle, and nobody would find out until an organizer
      asked why their poster looks like that.
    */
    const service = new ObjectStoreService(store({ get: jest.fn(async () => null) }));
    expect(await service.read(IN_BUCKET)).toBeNull();
  });

  it('answers null for a row with neither, rather than throwing into a render', async () => {
    const service = new ObjectStoreService(store());
    expect(
      await service.read({ bytes: null, storageKey: null, contentType: 'image/png' }),
    ).toBeNull();
  });
});

describe('ObjectStoreService.publicUrl', () => {
  it('has no address for a row still in the database', async () => {
    // Null is the normal answer today, so every caller must handle it: the API serves the bytes.
    const service = new ObjectStoreService(store({ publicUrl: () => 'https://cdn/x' }));
    expect(service.publicUrl(IN_DATABASE)).toBeNull();
  });

  it('hands out the store’s address for a row that has one', () => {
    const service = new ObjectStoreService(
      store({ publicUrl: (key) => `https://assets.example.com/${key}` }),
    );
    expect(service.publicUrl(IN_BUCKET)).toBe(
      'https://assets.example.com/public/events/ev1/abc.png',
    );
  });

  it('respects a driver that has no public address at all', () => {
    const service = new ObjectStoreService(store({ publicUrl: () => null }));
    expect(service.publicUrl(IN_BUCKET)).toBeNull();
  });
});

describe('ObjectStoreService.remove', () => {
  it('deletes the object a row points at', async () => {
    const s = store();
    await new ObjectStoreService(s).remove(IN_BUCKET);
    expect(s.delete).toHaveBeenCalledWith('public/events/ev1/abc.png');
  });

  it('does nothing for a row whose bytes are in the database', async () => {
    // Its bytes go with the row. Calling the store would be a delete of a key that never
    // existed, which some providers treat as an error.
    const s = store();
    await new ObjectStoreService(s).remove(IN_DATABASE);
    expect(s.delete).not.toHaveBeenCalled();
  });
});
