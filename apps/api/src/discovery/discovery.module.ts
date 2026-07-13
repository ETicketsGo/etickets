import { Module } from '@nestjs/common';
import { AiModule } from '../ai/ai.module';
import { EventsModule } from '../events/events.module';
import { MoviesModule } from '../movies/movies.module';
import { DiscoveryController } from './discovery.controller';
import { CapabilitiesController } from './capabilities.controller';
import { DiscoveryService } from './discovery.service';

/**
 * Unified experience discovery + platform capabilities. Reuses the existing
 * public event/movie services (imported via their modules) and the AI
 * RecommendationEngine port (from AiModule) — no business logic is duplicated.
 */
@Module({
  imports: [AiModule, EventsModule, MoviesModule],
  controllers: [DiscoveryController, CapabilitiesController],
  providers: [DiscoveryService],
})
export class DiscoveryModule {}
