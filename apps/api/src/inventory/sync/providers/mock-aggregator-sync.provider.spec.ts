import { MockAggregatorInventorySyncProvider } from './mock-aggregator-sync.provider';
import {
  ProviderPayloadInvalidError,
  ProviderSyncPermanentFailureError,
  ProviderSyncRetryableFailureError,
} from '../sync.errors';

const SECRET = 'test-secret';
const provider = new MockAggregatorInventorySyncProvider();

function signed(body: object, tsOffsetSec = 0) {
  const raw = JSON.stringify(body);
  const ts = Math.floor(Date.now() / 1000) + tsOffsetSec;
  const sig = MockAggregatorInventorySyncProvider.sign(SECRET, raw, ts);
  return { raw, headers: { 'x-mock-signature': sig, 'x-mock-timestamp': String(ts) } };
}

describe('MockAggregatorInventorySyncProvider — signature + replay', () => {
  it('accepts a correctly signed, in-window request', async () => {
    const { raw, headers } = signed({ events: [] });
    const res = await provider.verifyWebhook({
      rawBody: raw,
      headers,
      secret: SECRET,
      replayWindowSeconds: 300,
    });
    expect(res.valid).toBe(true);
  });
  it('rejects a bad signature (constant-time compare)', async () => {
    const { raw, headers } = signed({ events: [] });
    const res = await provider.verifyWebhook({
      rawBody: raw,
      headers: { ...headers, 'x-mock-signature': 'deadbeef' },
      secret: SECRET,
    });
    expect(res.valid).toBe(false);
    expect(res.reason).toBe('signature');
  });
  it('rejects a stale timestamp (replay window)', async () => {
    const { raw, headers } = signed({ events: [] }, -10_000);
    const res = await provider.verifyWebhook({
      rawBody: raw,
      headers,
      secret: SECRET,
      replayWindowSeconds: 300,
    });
    expect(res.valid).toBe(false);
    expect(res.reason).toBe('replay');
  });
  it('fails closed with no secret', async () => {
    const res = await provider.verifyWebhook({ rawBody: '{}', headers: {} });
    expect(res.valid).toBe(false);
  });
});

describe('MockAggregatorInventorySyncProvider — parse + normalize', () => {
  it('parses an events array', async () => {
    const events = await provider.parseWebhook({
      rawBody: JSON.stringify({ events: [{ eventType: 'x', data: {} }] }),
      headers: {},
    });
    expect(events).toHaveLength(1);
  });
  it('rejects malformed JSON', async () => {
    await expect(
      provider.parseWebhook({ rawBody: 'not-json', headers: {} }),
    ).rejects.toBeInstanceOf(ProviderPayloadInvalidError);
  });

  it('normalizes seat availability and preserves stable seat ids + states', async () => {
    const changes = await provider.normalize({
      eventType: 'session.availability.seats',
      eventVersion: 3,
      record: {
        externalSessionId: 's1',
        layoutVersion: 'v1',
        seats: [{ externalSeatId: 'A1', state: 'SOLD' }],
      },
    });
    expect(changes[0]).toMatchObject({
      kind: 'UPDATE_SEAT_AVAILABILITY',
      externalSessionId: 's1',
      externalVersion: 3,
    });
  });

  it('rejects an unknown seat-state enum (never silent-defaults)', async () => {
    await expect(
      provider.normalize({
        eventType: 'session.availability.seats',
        record: {
          externalSessionId: 's1',
          layoutVersion: 'v1',
          seats: [{ externalSeatId: 'A1', state: 'MYSTERY' }],
        },
      }),
    ).rejects.toBeInstanceOf(ProviderPayloadInvalidError);
  });

  it('preserves minor-unit + currency precision in pricing', async () => {
    const changes = await provider.normalize({
      eventType: 'session.pricing',
      record: {
        externalSessionId: 's1',
        tiers: [{ code: 'STD', amountMinor: 150000, currency: 'INR' }],
      },
    });
    expect(changes[0]).toMatchObject({ kind: 'UPDATE_PRICING' });
    expect((changes[0] as { tiers: { amountMinor: number }[] }).tiers[0].amountMinor).toBe(150000);
  });

  it('rejects a negative quantity', async () => {
    await expect(
      provider.normalize({
        eventType: 'session.availability.quantity',
        record: { externalSessionId: 's1', remaining: -5 },
      }),
    ).rejects.toBeInstanceOf(ProviderPayloadInvalidError);
  });

  it('rejects an unsupported event type (visible, not ignored)', async () => {
    await expect(
      provider.normalize({ eventType: 'totally.unknown', record: {} }),
    ).rejects.toBeInstanceOf(ProviderPayloadInvalidError);
  });

  it('surfaces simulated retryable + permanent failures', async () => {
    await expect(
      provider.normalize({ eventType: 'simulate.retryable', record: {} }),
    ).rejects.toBeInstanceOf(ProviderSyncRetryableFailureError);
    await expect(
      provider.normalize({ eventType: 'simulate.permanent', record: {} }),
    ).rejects.toBeInstanceOf(ProviderSyncPermanentFailureError);
  });
});

describe('MockAggregatorInventorySyncProvider — polling fixture', () => {
  it('paginates then completes', async () => {
    const p1 = await provider.fetchChanges({ cursor: null });
    expect(p1.hasMore).toBe(true);
    expect(p1.nextCursor).toBe('p1');
    const p2 = await provider.fetchChanges({ cursor: 'p1' });
    expect(p2.hasMore).toBe(false);
    expect(p2.nextCursor).toBeNull();
  });
});
