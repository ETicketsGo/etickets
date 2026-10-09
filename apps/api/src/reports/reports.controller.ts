import { Controller, Get, HttpStatus, Param, Query, Res } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Response } from 'express';
import { z } from 'zod';
import { AdminPermission, Role } from '@eticketsgo/shared-types';
import { paginationSchema } from '@eticketsgo/validation';
import { ReportsService } from './reports.service';
import { AuditQueryService, type AuditFilters } from '../audit/audit-query.service';
import { RequiresAdmin, CurrentUser, Roles, type RequestUser } from '../common/decorators';
import { ZodValidationPipe } from '../common/zod-validation.pipe';
import { AppException, ErrorCodes } from '../common/errors';
import { countryFilterField } from '../admin/country-filter';
import { dayField, idField, refineDateOrder } from '../admin/list-filters';

@ApiTags('reports')
@ApiBearerAuth()
@Controller('reports')
export class ReportsController {
  constructor(private readonly reports: ReportsService) {}

  @Get('events/:eventId')
  @ApiOperation({ summary: 'Organizer sales & operations report for an event (JSON or CSV).' })
  async eventReport(
    @CurrentUser() user: RequestUser,
    @Param('eventId') eventId: string,
    @Query(new ZodValidationPipe(z.object({ format: z.enum(['json', 'csv']).optional() })))
    q: { format?: 'json' | 'csv' },
    @Res({ passthrough: true }) res: Response,
  ) {
    if (q.format === 'csv') {
      const csv = await this.reports.organizerEventReportCsv(user, eventId);
      if (csv === null)
        throw new AppException(ErrorCodes.NOT_FOUND, 'Event not found.', HttpStatus.NOT_FOUND);
      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
      res.setHeader('Content-Disposition', `attachment; filename="event-report-${eventId}.csv"`);
      return res.send(csv);
    }
    return this.reports.organizerEventReport(user, eventId);
  }

  @Get('events/:eventId/commerce')
  @ApiOperation({
    summary: 'Commerce report for an event: add-ons, bundles, donations (JSON or CSV).',
  })
  async commerceReport(
    @CurrentUser() user: RequestUser,
    @Param('eventId') eventId: string,
    @Query(new ZodValidationPipe(z.object({ format: z.enum(['json', 'csv']).optional() })))
    q: { format?: 'json' | 'csv' },
    @Res({ passthrough: true }) res: Response,
  ) {
    if (q.format === 'csv') {
      const csv = await this.reports.organizerCommerceReportCsv(user, eventId);
      if (csv === null)
        throw new AppException(ErrorCodes.NOT_FOUND, 'Event not found.', HttpStatus.NOT_FOUND);
      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
      res.setHeader('Content-Disposition', `attachment; filename="commerce-report-${eventId}.csv"`);
      return res.send(csv);
    }
    return this.reports.organizerCommerceReport(user, eventId);
  }
}

/**
 * The audit filters, shared by the list and its summary so the two cannot accept different things.
 *
 * Dates are calendar days in UTC and validated as such: a value `new Date()` cannot read used to
 * reach Prisma as an Invalid Date and come back as a 500, which looks like the log is broken
 * rather than the link. A window that ends before it starts is a 400 for the same reason.
 */
const auditFilterFields = {
  action: z.string().trim().max(100).optional(),
  organizationId: idField,
  entityType: z.string().trim().max(100).optional(),
  country: countryFilterField,
  eventId: idField,
  from: dayField,
  to: dayField,
};

@ApiTags('admin')
@ApiBearerAuth()
@Roles(Role.ADMIN, Role.SUPER_ADMIN)
@RequiresAdmin(AdminPermission.BOOKING_READ)
@Controller('admin')
export class AdminReportsController {
  constructor(
    private readonly reports: ReportsService,
    private readonly auditQuery: AuditQueryService,
  ) {}

  @Get('dashboard')
  @ApiOperation({ summary: 'Platform admin dashboard metrics.' })
  dashboard() {
    return this.reports.adminDashboard();
  }

  /*
    ── THE AUDIT LOG NEEDED A WAY IN, NOT A REWRITE ──────────────────────────────────
    The filter used to be the action alone, and the console listed twenty rows of everything the
    platform did, newest first. Finding one organizer's week meant paging through the other
    thousands. So the filter now takes the organization, the entity type and a date window, and a
    second route says WHO and WHAT is in that window before anybody has to pick.

    The rows themselves are untouched. An audit record is one action, and grouping rows away
    would destroy the thing the log exists for.
  */
  @Get('audit')
  @ApiOperation({ summary: 'Search the audit log (admin), filtered by action, organizer or date.' })
  audit(
    @Query(
      new ZodValidationPipe(
        paginationSchema.extend(auditFilterFields).superRefine(refineDateOrder),
      ),
    )
    q: { page: number; pageSize: number } & AuditFilters,
  ) {
    return this.auditQuery.list(q, q.page, q.pageSize);
  }

  @Get('audit/summary')
  @ApiOperation({
    summary: 'Audit activity grouped by organizer (with country) and by action, for a window.',
  })
  auditSummary(
    @Query(new ZodValidationPipe(z.object(auditFilterFields).superRefine(refineDateOrder)))
    q: AuditFilters,
  ) {
    return this.auditQuery.summary(q);
  }
}
