import { QubeMockInventorySyncProvider } from './qube-mock-sync.provider';
import { QubeMockInventoryProvider } from '../../sourcing/providers/qube/qube-mock.provider';
import { ProviderPayloadInvalidError, ProviderSyncPermanentFailureError } from '../sync.errors';

/**
 * The catalogue feed, read the way the polling coordinator reads it.
 *
 * What matters here is not that the sandbox has three screens. It is that the same catalogue,
 * read twice, produces the same event ids — because that is the only thing standing between
 * "sync ran again" and "the storefront now has two of everything".
 */
function harness() {
  const sandbox = new QubeMockInventoryProvider();
  sandbox.reset();
  return { sandbox, sync: new QubeMockInventorySyncProvider(sandbox) };
}

/** Walk every page the way `SyncPollingService.poll` does, cursor and all. */
async function drain(sync: QubeMockInventorySyncProvider) {
  const records = [];
  let cursor: string | null = null;
  for (let page = 0; page < 10; page++) {
    const batch: Awaited<ReturnType<QubeMockInventorySyncProvider['fetchChanges']>> =
      await sync.fetchChanges({ cursor });
    records.push(...batch.records);
    cursor = batch.nextCursor;
    if (!batch.hasMore) break;
  }
  return records;
}

describe('QUBE_MOCK as a catalogue feed', () => {
  it('publishes the whole catalogue in dependency order', async () => {
    const { sync } = harness();
    const records = await drain(sync);
    const types = records.map((r) => r.eventType);

    // A show references a screen and a film. Emitting it first would leave the importer with
    // a screening and nowhere to put it.
    const firstOf = (t: string) => types.findIndex((x) => x === t);
    expect(firstOf('catalogue.venue.upserted')).toBeLessThan(firstOf('catalogue.screen.upserted'));
    expect(firstOf('catalogue.screen.upserted')).toBeLessThan(
      firstOf('catalogue.session.upserted'),
    );
    expect(firstOf('catalogue.experience.upserted')).toBeLessThan(
      firstOf('catalogue.session.upserted'),
    );

    expect(types.filter((t) => t === 'catalogue.venue.upserted')).toHaveLength(1);
    expect(types.filter((t) => t === 'catalogue.screen.upserted')).toHaveLength(3);
    expect(types.filter((t) => t === 'catalogue.experience.upserted')).toHaveLength(2);
  });

  it('produces byte-identical event ids for an unchanged catalogue', async () => {
    const { sync } = harness();
    const first = (await drain(sync)).map((r) => r.externalEventId);
    const second = (await drain(sync)).map((r) => r.externalEventId);

    /*
      This is the idempotency guarantee, and it lives HERE rather than downstream. Ingestion
      dedupes on the event id, so identical ids mean a re-poll of an unchanged catalogue never
      becomes a raw event at all — not "becomes one and is then ignored". The difference is a
      table that grows once versus one that grows every five minutes forever.
    */
    expect(second).toEqual(first);
    expect(new Set(first).size).toBe(first.length); // and no duplicates within one pass
  });

  it('gives a changed record a new id and a higher version', async () => {
    const { sandbox, sync } = harness();
    const before = await drain(sync);
    const show = (await sandbox.getShows({}))[0];

    sandbox.rescheduleShow(show.externalId, new Date(show.startsAt.getTime() + 30 * 60_000));

    const after = await drain(sync);
    const beforeRecord = before.find((r) => r.externalEntityId === show.externalId)!;
    const afterRecord = after.find((r) => r.externalEntityId === show.externalId)!;

    expect(afterRecord.externalEventId).not.toBe(beforeRecord.externalEventId);
    expect(afterRecord.eventVersion).toBe((beforeRecord.eventVersion ?? 0) + 1);
    // Same show, though: the id the mapping keys on has not moved.
    expect(afterRecord.externalEntityId).toBe(beforeRecord.externalEntityId);
    // And nothing else in the catalogue was disturbed by one show moving.
    const unchanged = after.filter((r) => r.externalEntityId !== show.externalId);
    expect(unchanged.map((r) => r.externalEventId)).toEqual(
      before.filter((r) => r.externalEntityId !== show.externalId).map((r) => r.externalEventId),
    );
  });

  it('normalizes into the canonical vocabulary, never a provider shape', async () => {
    const { sync } = harness();
    const records = await drain(sync);
    const session = records.find((r) => r.eventType === 'catalogue.session.upserted')!;

    const [change] = await sync.normalize(session);
    expect(change).toMatchObject({
      kind: 'UPSERT_SESSION',
      externalEntityType: 'SESSION',
      status: 'SCHEDULED',
    });
    // Times cross the seam as ISO instants with a zone, never as a wall clock.
    expect((change as { startsAt: string }).startsAt).toMatch(/Z$/);
    expect((change as { timezone?: string }).timezone).toBe('Asia/Kolkata');
  });

  it('rejects a record whose shape it does not recognise, rather than coercing it', async () => {
    const { sync } = harness();
    await expect(
      sync.normalize({ eventType: 'catalogue.session.upserted', record: { externalId: 'x' } }),
    ).rejects.toBeInstanceOf(ProviderPayloadInvalidError);
    await expect(
      sync.normalize({ eventType: 'catalogue.mystery', record: {} }),
    ).rejects.toBeInstanceOf(ProviderSyncPermanentFailureError);
  });

  it('does not pretend to have webhooks', async () => {
    const { sync } = harness();
    expect(sync.supportsWebhooks).toBe(false);
    // We do not know whether Qube publishes events. A sandbox that answered would be inventing
    // the capability the integration then gets designed around.
    expect((await sync.verifyWebhook()).valid).toBe(false);
    await expect(sync.parseWebhook()).rejects.toBeInstanceOf(ProviderSyncPermanentFailureError);
  });

  it('reports the sandbox unhealthy when the sandbox is down', async () => {
    const { sandbox, sync } = harness();
    expect((await sync.health()).state).toBe('HEALTHY');
    sandbox.setOutage('unavailable');
    expect((await sync.health()).state).toBe('UNHEALTHY');
  });

  it('declares the exhibitor as the inventory owner', () => {
    const { sync } = harness();
    // Which is what stops an imported availability figure overwriting stock we own.
    expect(sync.ownershipMode).toBe('PROVIDER_AUTHORITATIVE');
  });
});
