import { Controller, Get, HttpStatus, Param, Query, Res } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Response } from 'express';
import { z } from 'zod';
import { Role } from '@eticketsgo/shared-types';
import { paginationSchema } from '@eticketsgo/validation';
import { ReportsService } from './reports.service';
import { PrismaService } from '../prisma/prisma.service';
import { CurrentUser, Roles, type RequestUser } from '../common/decorators';
import { ZodValidationPipe } from '../common/zod-validation.pipe';
import { AppException, ErrorCodes } from '../common/errors';

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

@ApiTags('admin')
@ApiBearerAuth()
@Roles(Role.ADMIN, Role.SUPER_ADMIN)
@Controller('admin')
export class AdminReportsController {
  constructor(
    private readonly reports: ReportsService,
    private readonly prisma: PrismaService,
  ) {}

  @Get('dashboard')
  @ApiOperation({ summary: 'Platform admin dashboard metrics.' })
  dashboard() {
    return this.reports.adminDashboard();
  }

  @Get('audit')
  @ApiOperation({ summary: 'Search the audit log (admin).' })
  async audit(
    @Query(new ZodValidationPipe(paginationSchema.extend({ action: z.string().optional() })))
    q: {
      page: number;
      pageSize: number;
      action?: string;
    },
  ) {
    const where = q.action ? { action: q.action } : {};
    const [total, data] = await this.prisma.$transaction([
      this.prisma.auditLog.count({ where }),
      this.prisma.auditLog.findMany({
        where,
        skip: (q.page - 1) * q.pageSize,
        take: q.pageSize,
        orderBy: { createdAt: 'desc' },
        include: { actor: { select: { email: true, fullName: true } } },
      }),
    ]);
    return {
      data,
      meta: {
        page: q.page,
        pageSize: q.pageSize,
        total,
        totalPages: Math.ceil(total / q.pageSize),
      },
    };
  }
}
