import { Module } from '@nestjs/common';
import { AiModule } from '../ai/ai.module';
import { EventsModule } from '../events/events.module';
import { MoviesModule } from '../movies/movies.module';
import { DiscoveryController } from './discovery.controller';
import { CapabilitiesController } from './capabilities.controller';
import { DiscoveryService } from './discovery.service';
import { DiscoverySectionsService } from './discovery-sections.service';
import {
  DISCOVERY_STRATEGIES,
  type DiscoveryStrategy,
} from './strategies/discovery-strategy.interface';
import { TrendingStrategy } from './strategies/trending.strategy';
import { PopularStrategy } from './strategies/popular.strategy';
import { WeekendStrategy } from './strategies/weekend.strategy';
import { NewReleasesStrategy } from './strategies/new-releases.strategy';
import { NearbyStrategy } from './strategies/nearby.strategy';
import { OrganizerSpotlightStrategy } from './strategies/organizer-spotlight.strategy';
import { VenueSpotlightStrategy } from './strategies/venue-spotlight.strategy';
import { RecommendedStrategy } from './strategies/recommended.strategy';

/**
 * Unified experience discovery + platform capabilities. Reuses the existing
 * public event/movie services (imported via their modules) and the AI
 * RecommendationEngine port (from AiModule) — no business logic is duplicated.
 *
 * The discovery *sections* feed is composed from a registry of DiscoveryStrategy
 * providers. The `DISCOVERY_STRATEGIES` token collects them in render order;
 * adding a section = adding a strategy here (no composer change). Empty sections
 * are dropped by DiscoverySectionsService.
 */
@Module({
  imports: [AiModule, EventsModule, MoviesModule],
  controllers: [DiscoveryController, CapabilitiesController],
  providers: [
    DiscoveryService,
    DiscoverySectionsService,
    TrendingStrategy,
    PopularStrategy,
    WeekendStrategy,
    NewReleasesStrategy,
    NearbyStrategy,
    OrganizerSpotlightStrategy,
    VenueSpotlightStrategy,
    RecommendedStrategy,
    {
      provide: DISCOVERY_STRATEGIES,
      useFactory: (
        recommended: RecommendedStrategy,
        trending: TrendingStrategy,
        popular: PopularStrategy,
        nearby: NearbyStrategy,
        weekend: WeekendStrategy,
        newReleases: NewReleasesStrategy,
        organizers: OrganizerSpotlightStrategy,
        venues: VenueSpotlightStrategy,
      ): DiscoveryStrategy[] => [
        recommended,
        trending,
        popular,
        nearby,
        weekend,
        newReleases,
        organizers,
        venues,
      ],
      inject: [
        RecommendedStrategy,
        TrendingStrategy,
        PopularStrategy,
        NearbyStrategy,
        WeekendStrategy,
        NewReleasesStrategy,
        OrganizerSpotlightStrategy,
        VenueSpotlightStrategy,
      ],
    },
  ],
})
export class DiscoveryModule {}
