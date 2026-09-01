import { Controller, Get, Query, Req } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';
import { z } from 'zod';
import { LocationService } from './location.service';
import { Public } from '../common/decorators';
import { ZodValidationPipe } from '../common/zod-validation.pipe';

const citiesQuery = z.object({
  /** Prefix of the city name. Absent means "the busiest ones", which is what a picker opens on. */
  q: z.string().trim().max(60).optional(),
  country: z.string().trim().min(2).max(60).optional(),
  limit: z.coerce.number().int().min(1).max(50).optional(),
});

const resolveQuery = z.object({
  /**
   * Coordinates, only ever sent when the person pressed "use my location".
   *
   * Optional and bounded. Nothing here is stored — they are used to pick a city name and
   * then discarded, because a precise home location is a far more sensitive thing to keep
   * than the city it resolves to.
   */
  lat: z.coerce.number().min(-90).max(90).optional(),
  lng: z.coerce.number().min(-180).max(180).optional(),
  /** The device's configured region (ISO alpha-2), used as a last-resort country hint. */
  region: z.string().trim().length(2).optional(),
});

@ApiTags('public')
@Controller('public/location')
export class LocationController {
  constructor(private readonly location: LocationService) {}

  @Public()
  @Get('cities')
  @ApiOperation({
    summary: 'Search cities with something on sale, most inventory first.',
    description:
      'A search rather than a dump: the picker asks for a prefix and a small limit as the ' +
      'customer types, so the response stays the same size whether the platform sells in ' +
      'six cities or six hundred.',
  })
  cities(
    @Query(new ZodValidationPipe(citiesQuery))
    q: {
      q?: string;
      country?: string;
      limit?: number;
    },
  ) {
    return this.location.cities(q);
  }

  @Public()
  @Get('resolve')
  @ApiOperation({
    summary: 'Best guess at the caller location, with the source and whether to confirm it.',
  })
  resolve(
    @Req() req: Request,
    @Query(new ZodValidationPipe(resolveQuery))
    q: { lat?: number; lng?: number; region?: string },
  ) {
    return this.location.resolve({
      // Read from the request, never from a query parameter: an edge header is only
      // trustworthy because the proxy sets it and a client cannot.
      headers: req.headers as Record<string, string | string[] | undefined>,
      latitude: q.lat,
      longitude: q.lng,
      deviceRegion: q.region,
    });
  }
}
