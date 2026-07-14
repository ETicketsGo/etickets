import { Controller, Get, Header, Res } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Response } from 'express';
import { Public } from '../common/decorators';
import { MetricsService } from './metrics.service';

/**
 * Prometheus scrape target. Public (no auth) so a scraper can reach it, but in
 * production this route MUST be network-restricted to the metrics scraper only
 * (see docs/reports/OPERATIONS.md) — it is not intended for the public internet.
 */
@ApiTags('ops')
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
