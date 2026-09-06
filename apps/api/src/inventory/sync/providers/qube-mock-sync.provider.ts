import { Injectable } from '@nestjs/common';
import { z } from 'zod';
import { QubeMockInventoryProvider } from '../../sourcing/providers/qube/qube-mock.provider';
import { QUBE_MOCK_PROVIDER_CODE } from '../../sourcing/providers/qube/qube-mock.fixture';
import { ProviderPayloadInvalidError, ProviderSyncPermanentFailureError } from '../sync.errors';
import type {
  InventorySyncProvider,
  ProviderChangeBatch,
  ProviderChangeFetchRequest,
  ProviderChangeRecord,
  ProviderSyncHealth,
  ProviderWebhookEvent,
  ProviderWebhookVerificationResult,
} from '../contracts/sync-provider.interface';
import type { CanonicalInventoryChange } from '../contracts/canonical-change';

/**
 * The Qube sandbox as the SYNC platform sees it (ADR-040).
 *
 * ── WHY A THIRD ADAPTER FOR ONE SANDBOX ────────────────────────────────────────────
 * `QubeMockInventoryProvider` answers "is F10 free, and may I hold it" — a question about one
 * show, asked during a checkout. This answers a different one: "what does the exhibitor's
 * catalogue look like, and what changed since I last asked". A provider can do either without
 * the other — a mirrored feed publishes a catalogue it cannot sell, a booking-only API sells
 * shows it never lists — so ADR-040 keeps them apart, and this is the adapter for that seam.
 *
 * It DELEGATES to the same in-memory sandbox rather than holding a second copy, for the same
 * reason the booking adapter does: two stores describing one cinema agree only by luck, and
 * the first divergence is a customer looking at a show the seat map has never heard of.
 *
 * ── WHAT IT DOES NOT DO ────────────────────────────────────────────────────────────
 * It does not create, rename or publish anything internal. Its output is canonical changes;
 * the platform records them, maps identity, and stops. Turning a mapped external show into a
 * SELLABLE ETicketsGo show is a separate, governed step — see `catalogue-governance.md`.
 * That separation is the point: a vendor feed must never be able to publish.
 */

/*
  Polling emits the catalogue in DEPENDENCY ORDER — cinema, then screens, then films, then
  shows — because a show references a screen and a film. The order is not cosmetic: a show
  arriving before the room it plays in has nothing to attach to.
*/
const RESOURCE_ORDER = ['VENUE', 'SCREEN', 'EXPERIENCE', 'SESSION'] as const;

type Resource = (typeof RESOURCE_ORDER)[number];

const venueRecord = z.object({
  externalId: z.string().min(1),
  name: z.string().min(1),
  city: z.string().optional(),
  timezone: z.string().optional(),
  revision: z.number().int().min(1),
});
const screenRecord = z.object({
  externalId: z.string().min(1),
  cinemaExternalId: z.string().min(1),
  name: z.string().min(1),
  revision: z.number().int().min(1),
});
const experienceRecord = z.object({
  externalId: z.string().min(1),
  title: z.string().min(1),
  language: z.string().optional(),
  runtimeMinutes: z.number().int().positive().optional(),
  revision: z.number().int().min(1),
});
const sessionRecord = z.object({
  externalId: z.string().min(1),
  cinemaExternalId: z.string().min(1),
  screenExternalId: z.string().min(1),
  movieExternalId: z.string().min(1),
  startsAt: z.string().min(1),
  endsAt: z.string().optional(),
  timezone: z.string().optional(),
  revision: z.number().int().min(1),
});

@Injectable()
export class QubeMockInventorySyncProvider implements InventorySyncProvider {
  readonly providerCode = QUBE_MOCK_PROVIDER_CODE;
  /** The exhibitor owns this stock. Nothing here may overwrite locally-owned inventory. */
  readonly ownershipMode = 'PROVIDER_AUTHORITATIVE' as const;
  /**
   * No webhooks, deliberately.
   *
   * We do not know whether Qube has any — it is an open question in `qube-readiness.md` — and
   * a sandbox that answers it invents a capability the integration would then be built on.
   * Polling is the assumption that is safe to be wrong about: a provider that turns out to
   * push events makes polling redundant, whereas assuming push and getting none is a
   * catalogue that silently stops updating.
   */
  readonly supportsWebhooks = false;
  readonly supportsPolling = true;

  constructor(private readonly sandbox: QubeMockInventoryProvider) {}

  async verifyWebhook(): Promise<ProviderWebhookVerificationResult> {
    // Not a quiet `false`: a webhook arriving for a provider with no webhook contract means
    // something is misconfigured, and a soft answer would hide it.
    return { valid: false, reason: 'unsupported' };
  }

  async parseWebhook(): Promise<ProviderWebhookEvent[]> {
    throw new ProviderSyncPermanentFailureError('QUBE_MOCK does not publish webhooks');
  }

  /**
   * One page per resource kind, walked in dependency order.
   *
   * The cursor is the resource just finished, so a run that dies halfway resumes where it
   * stopped instead of re-reading the whole catalogue — the shape a real paged feed has, and
   * exercised for real by the durable checkpoint service.
   */
  async fetchChanges(req: ProviderChangeFetchRequest): Promise<ProviderChangeBatch> {
    // An unrecognised cursor restarts from the beginning rather than skipping ahead: the
    // catalogue is cheap to re-read and dedupes on event id, whereas guessing at a position
    // would silently miss a resource.
    const seen = req.cursor ? RESOURCE_ORDER.indexOf(req.cursor as Resource) : -1;
    const index = seen + 1;
    if (index >= RESOURCE_ORDER.length) {
      // Fully read. The next cycle starts over, which is what an incremental poll does;
      // unchanged records cost nothing because they dedupe on their event id.
      return { records: [], nextCursor: null, hasMore: false };
    }
    const resource = RESOURCE_ORDER[index];
    const records = await this.recordsFor(resource);
    return { records, nextCursor: resource, hasMore: index < RESOURCE_ORDER.length - 1 };
  }

  private async recordsFor(resource: Resource): Promise<ProviderChangeRecord[]> {
    const rev = (id: string): number => this.sandbox.revision(id);
    switch (resource) {
      case 'VENUE': {
        const cinemas = await this.sandbox.getCinemas();
        return cinemas.map((c) =>
          this.record('VENUE', c.externalId, {
            externalId: c.externalId,
            name: c.name,
            city: c.city,
            timezone: c.timezone,
            revision: rev(c.externalId),
          }),
        );
      }
      case 'SCREEN': {
        const screens = await this.sandbox.getScreens();
        return screens.map((s) =>
          this.record('SCREEN', s.externalId, {
            externalId: s.externalId,
            cinemaExternalId: s.cinemaExternalId,
            name: s.name,
            revision: rev(s.externalId),
          }),
        );
      }
      case 'EXPERIENCE': {
        const movies = await this.sandbox.getMovies();
        return movies.map((m) =>
          this.record('EXPERIENCE', m.externalId, {
            externalId: m.externalId,
            title: m.title,
            language: m.language,
            runtimeMinutes: m.runtimeMinutes,
            revision: rev(m.externalId),
          }),
        );
      }
      case 'SESSION': {
        const shows = await this.sandbox.getShows({});
        return shows.map((s) =>
          this.record('SESSION', s.externalId, {
            externalId: s.externalId,
            cinemaExternalId: s.cinemaExternalId,
            screenExternalId: s.screenExternalId,
            movieExternalId: s.movieExternalId,
            startsAt: s.startsAt.toISOString(),
            endsAt: s.endsAt?.toISOString(),
            timezone: (s.raw as { timezone?: string } | undefined)?.timezone,
            revision: rev(s.externalId),
          }),
        );
      }
    }
  }

  /**
   * The event id carries the record's REVISION.
   *
   * That is what makes a second poll of an unchanged catalogue free: ingestion dedupes on
   * this id, so an unchanged show is not merely applied-then-ignored downstream — it never
   * becomes a raw event at all. A changed show gets a new id and flows through.
   */
  private record(
    entityType: Resource,
    externalId: string,
    record: { revision: number } & Record<string, unknown>,
  ): ProviderChangeRecord {
    return {
      externalEventId: `${QUBE_MOCK_PROVIDER_CODE}:${entityType}:${externalId}:v${record.revision}`,
      eventType: `catalogue.${entityType.toLowerCase()}.upserted`,
      eventVersion: record.revision,
      externalEntityId: externalId,
      record,
    };
  }

  async normalize(
    event: ProviderWebhookEvent | ProviderChangeRecord,
  ): Promise<CanonicalInventoryChange[]> {
    const externalVersion = event.eventVersion;
    switch (event.eventType) {
      case 'catalogue.venue.upserted': {
        const r = this.parse(venueRecord, event.record);
        return [
          {
            kind: 'UPSERT_VENUE',
            externalEntityType: 'VENUE',
            externalEntityId: r.externalId,
            externalVersion,
            name: r.name,
            city: r.city,
            timezone: r.timezone,
          },
        ];
      }
      case 'catalogue.screen.upserted': {
        const r = this.parse(screenRecord, event.record);
        return [
          {
            kind: 'UPSERT_SCREEN',
            externalEntityType: 'SCREEN',
            externalEntityId: r.externalId,
            externalVersion,
            externalVenueId: r.cinemaExternalId,
            name: r.name,
          },
        ];
      }
      case 'catalogue.experience.upserted': {
        const r = this.parse(experienceRecord, event.record);
        return [
          {
            kind: 'UPSERT_EXPERIENCE',
            externalEntityType: 'EXPERIENCE',
            externalEntityId: r.externalId,
            externalVersion,
            title: r.title,
            experienceType: 'MOVIE',
            language: r.language,
            durationMinutes: r.runtimeMinutes,
          },
        ];
      }
      case 'catalogue.session.upserted': {
        const r = this.parse(sessionRecord, event.record);
        return [
          {
            kind: 'UPSERT_SESSION',
            externalEntityType: 'SESSION',
            externalEntityId: r.externalId,
            externalVersion,
            externalExperienceId: r.movieExternalId,
            externalVenueId: r.cinemaExternalId,
            externalScreenId: r.screenExternalId,
            startsAt: r.startsAt,
            timezone: r.timezone,
            // The sandbox publishes only live shows. A cancellation arrives as its own change
            // kind and is deliberately NOT inferred from absence — a missing record is far
            // more often a paging bug than a cancelled screening.
            status: 'SCHEDULED',
          },
        ];
      }
      default:
        throw new ProviderSyncPermanentFailureError(`unknown event type ${event.eventType}`);
    }
  }

  private parse<T>(schema: z.ZodType<T>, record: unknown): T {
    const parsed = schema.safeParse(record);
    if (!parsed.success) {
      // Reject visibly rather than coercing. A field we did not expect is a change in the
      // vendor's contract, and guessing at it is how a bad import becomes a wrong showtime.
      throw new ProviderPayloadInvalidError('qube_mock_record_invalid');
    }
    return parsed.data;
  }

  async health(): Promise<ProviderSyncHealth> {
    const h = await this.sandbox.health().catch(() => ({ healthy: false, reason: 'unreachable' }));
    return {
      state: h.healthy ? 'HEALTHY' : 'UNHEALTHY',
      reason: (h as { reason?: string }).reason,
      checkedAt: new Date().toISOString(),
    };
  }
}
