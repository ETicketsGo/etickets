import { Controller, Get, Param, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { z } from 'zod';
import { Role } from '@eticketsgo/shared-types';
import { paginationSchema } from '@eticketsgo/validation';
import { ReportsService } from './reports.service';
import { PrismaService } from '../prisma/prisma.service';
import { CurrentUser, Roles, type RequestUser } from '../common/decorators';
import { ZodValidationPipe } from '../common/zod-validation.pipe';

@ApiTags('reports')
@ApiBearerAuth()
@Controller('reports')
export class ReportsController {
  constructor(private readonly reports: ReportsService) {}

  @Get('events/:eventId')
  @ApiOperation({ summary: 'Organizer sales & operations report for an event.' })
  eventReport(@CurrentUser() user: RequestUser, @Param('eventId') eventId: string) {
    return this.reports.organizerEventReport(user, eventId);
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
