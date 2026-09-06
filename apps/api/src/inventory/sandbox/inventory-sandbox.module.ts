import { Module } from '@nestjs/common';
import { CinemasModule } from '../../cinemas/cinemas.module';
import { MoviesModule } from '../../movies/movies.module';
import { ShowsModule } from '../../shows/shows.module';
import { InventorySourcingModule } from '../sourcing/inventory-sourcing.module';
import { SandboxCatalogueMaterializer } from './sandbox-catalogue.materializer';

/**
 * Sandbox-only catalogue materialization.
 *
 * Constructed always, active never by default: the materializer refuses unless
 * `INVENTORY_SANDBOX_MATERIALIZATION_ENABLED` is on, `APP_ENV` is not a production-like
 * environment, AND the provider is the Qube sandbox. Importing this module changes no
 * behaviour and adds no route — there is deliberately no HTTP surface, because a catalogue
 * auto-publisher reachable over the network is exactly what the governance model forbids.
 *
 * Real-provider catalogue approval goes through the ADR-040 ops surface instead
 * (`/admin/inventory-sync/mappings`), which requires a person.
 */
@Module({
  imports: [CinemasModule, MoviesModule, ShowsModule, InventorySourcingModule],
  providers: [SandboxCatalogueMaterializer],
  exports: [SandboxCatalogueMaterializer],
})
export class InventorySandboxModule {}
