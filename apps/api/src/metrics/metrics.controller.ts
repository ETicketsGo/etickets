import { Controller, Get, Header, Res, UseGuards } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Response } from 'express';
import { Public } from '../common/decorators';
import { MetricsService } from './metrics.service';
import { MetricsAccessGuard } from './metrics-access.guard';

/**
 * Prometheus scrape target.
 *
 * This used to say the route "MUST be network-restricted to the metrics scraper only".
 * That control did not exist: on Railway a service either has a public domain or it does
 * not, and this one does — so the endpoint was readable by anyone who typed the URL, and
 * it publishes `etg_gmv_minor_total` among other things. A comment is not an access
 * control. `MetricsAccessGuard` is.
 *
 * Still `@Public()`: a scraper has no user and cannot hold a JWT, so the JWT guard is the
 * wrong instrument. The scrape token replaces it rather than being layered on top.
 */
@ApiTags('ops')
@UseGuards(MetricsAccessGuard)
@Controller('metrics')
export class MetricsController {
  constructor(private readonly metrics: MetricsService) {}

  @Public()
  @Get()
  @Header('Cache-Control', 'no-store')
  @ApiOperation({ summary: 'Prometheus metrics exposition (ops-only).' })
  async scrape(@Res() res: Response): Promise<void> {
    res.setHeader('Content-Type', this.metrics.contentType);
    res.send(await this.metrics.metrics());
  }
}
