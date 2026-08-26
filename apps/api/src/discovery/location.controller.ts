import { Controller, Get, Query, Req } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';
import { z } from 'zod';
import { LocationService } from './location.service';
import { Public } from '../common/decorators';
import { ZodValidationPipe } from '../common/zod-validation.pipe';

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
  @ApiOperation({ summary: 'Cities with something on sale, most inventory first.' })
  cities() {
    return this.location.cities();
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
