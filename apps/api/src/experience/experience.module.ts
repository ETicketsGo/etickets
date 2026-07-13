import { Module } from '@nestjs/common';
import { ExperienceTypeRegistry } from './experience-type.registry';

/**
 * The Experience domain root. Existing Events are `ExperienceType.EVENT`; this
 * module owns the mapping from experience type to platform capabilities and will
 * grow (movie/museum/tour domains) in later PRs without touching the booking
 * engine. See ADR-009.
 */
@Module({
  providers: [ExperienceTypeRegistry],
  exports: [ExperienceTypeRegistry],
})
export class ExperienceModule {}
