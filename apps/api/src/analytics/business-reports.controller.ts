import { Controller, Get, Query, Res } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Response } from 'express';
import { z } from 'zod';
import { Role } from '@eticketsgo/shared-types';
import { BusinessReportsService, resolveRange } from './business-reports.service';
import { Roles } from '../common/decorators';
import { ZodValidationPipe } from '../common/zod-validation.pipe';

const rangeQuery = z.object({
  from: z.string().min(1).optional(),
  to: z.string().min(1).optional(),
  limit: z.coerce.number().int().positive().max(100).optional(),
  format: z.enum(['json', 'csv']).optional(),
});
type RangeQuery = z.infer<typeof rangeQuery>;

/** Send a CSV document with a download filename derived from the report + range. */
function sendCsv(
  res: Response,
  report: string,
  range: { from: Date; to: Date },
  csv: string,
): void {
  const stamp = `${range.from.toISOString().slice(0, 10)}_${range.to.toISOString().slice(0, 10)}`;
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${report}_${stamp}.csv"`);
  res.send(csv);
}

/**
 * Admin business-operations reports. All routes are ADMIN / SUPER_ADMIN, read-only,
 * and accept an optional `?from=&to=` range (default last 30 days) where a time
 * dimension applies. `?format=csv` returns `text/csv` for the exportable reports.
 */
@ApiTags('admin')
@ApiBearerAuth()
@Roles(Role.ADMIN, Role.SUPER_ADMIN)
@Controller('admin/reports')
export class AdminBusinessReportsController {
  constructor(private readonly reports: BusinessReportsService) {}

  @Get('daily-revenue')
  @ApiOperation({ summary: 'Daily revenue time series: gross, platform fees, refunds, net GMV.' })
  async dailyRevenue(
    @Query(new ZodValidationPipe(rangeQuery)) q: RangeQuery,
    @Res({ passthrough: true }) res: Response,
  ) {
    const range = resolveRange(q.from, q.to);
    if (q.format === 'csv') {
      return sendCsv(
        res,
        'daily-revenue',
        range,
        await this.reports.dailyRevenueCsv(range.from, range.to),
      );
    }
    return this.reports.dailyRevenue(range.from, range.to);
  }

  @Get('organizer-revenue')
  @ApiOperation({ summary: 'Per-organization gross/net/refunds/bookings (Top Organizers).' })
  async organizerRevenue(
    @Query(new ZodValidationPipe(rangeQuery)) q: RangeQuery,
    @Res({ passthrough: true }) res: Response,
  ) {
    const range = resolveRange(q.from, q.to);
    if (q.format === 'csv') {
      return sendCsv(
        res,
        'organizer-revenue',
        range,
        await this.reports.organizerRevenueCsv(range.from, range.to, q.limit),
      );
    }
    return this.reports.organizerRevenue(range.from, range.to, q.limit);
  }

  @Get('settlement')
  @ApiOperation({ summary: 'Outstanding (PENDING/SCHEDULED) vs PAID payouts per organizer.' })
  async settlement(
    @Query(new ZodValidationPipe(rangeQuery)) q: RangeQuery,
    @Res({ passthrough: true }) res: Response,
  ) {
    if (q.format === 'csv') {
      const range = resolveRange(q.from, q.to);
      return sendCsv(res, 'settlement', range, await this.reports.settlementCsv());
    }
    return this.reports.settlement();
  }

  @Get('refunds')
  @ApiOperation({ summary: 'Refund count + amount by day and by status.' })
  async refunds(
    @Query(new ZodValidationPipe(rangeQuery)) q: RangeQuery,
    @Res({ passthrough: true }) res: Response,
  ) {
    const range = resolveRange(q.from, q.to);
    if (q.format === 'csv') {
      return sendCsv(res, 'refunds', range, await this.reports.refundsCsv(range.from, range.to));
    }
    return this.reports.refunds(range.from, range.to);
  }

  @Get('platform-fees')
  @ApiOperation({ summary: 'Platform fee revenue over the range + daily series.' })
  platformFees(@Query(new ZodValidationPipe(rangeQuery)) q: RangeQuery) {
    const range = resolveRange(q.from, q.to);
    return this.reports.platformFees(range.from, range.to);
  }

  @Get('tax')
  @ApiOperation({ summary: 'Taxable base + honest taxModelled:false flag (GST not implemented).' })
  tax(@Query(new ZodValidationPipe(rangeQuery)) q: RangeQuery) {
    const range = resolveRange(q.from, q.to);
    return this.reports.tax(range.from, range.to);
  }

  @Get('top-experiences')
  @ApiOperation({ summary: 'Top events/movies by confirmed bookings and revenue.' })
  topExperiences(@Query(new ZodValidationPipe(rangeQuery)) q: RangeQuery) {
    const range = resolveRange(q.from, q.to);
    return this.reports.topExperiences(range.from, range.to, q.limit ?? 10);
  }

  @Get('growth')
  @ApiOperation({
    summary: 'New users + new bookings + new organizers daily series and retention.',
  })
  growth(@Query(new ZodValidationPipe(rangeQuery)) q: RangeQuery) {
    const range = resolveRange(q.from, q.to);
    return this.reports.growth(range.from, range.to);
  }

  @Get('payment-health')
  @ApiOperation({ summary: 'Payment success rate overall and per provider.' })
  paymentHealth(@Query(new ZodValidationPipe(rangeQuery)) q: RangeQuery) {
    const range = resolveRange(q.from, q.to);
    return this.reports.paymentHealth(range.from, range.to);
  }
}
