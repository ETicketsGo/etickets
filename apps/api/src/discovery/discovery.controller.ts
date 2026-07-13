import { Controller, Get, Query } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { z } from 'zod';
import { DiscoveryService } from './discovery.service';
import { DiscoverySectionsService } from './discovery-sections.service';
import { Public } from '../common/decorators';
import { ZodValidationPipe } from '../common/zod-validation.pipe';

@ApiTags('public')
@Controller('public/discovery')
export class DiscoveryController {
  constructor(
    private readonly discovery: DiscoveryService,
    private readonly sections: DiscoverySectionsService,
  ) {}

  @Public()
  @Get()
  @ApiOperation({ summary: 'Unified experience discovery (movies + events + categories).' })
  get() {
    return this.discovery.get();
  }

  @Public()
  @Get('sections')
  @ApiOperation({ summary: 'Composed discovery sections from the discovery strategies.' })
  getSections(
    @Query(new ZodValidationPipe(z.object({ city: z.string().optional() })))
    q: {
      city?: string;
    },
  ) {
    return this.sections.sections(q.city);
  }
}
