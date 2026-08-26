import { Body, Controller, Get, Header, Ip, Param, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { z } from 'zod';
import { AdminPermission, Role } from '@eticketsgo/shared-types';
import { RequiresAdmin, CurrentUser, Roles, type RequestUser } from '../../common/decorators';
import { ZodValidationPipe } from '../../common/zod-validation.pipe';
import { FinanceReconciliationService } from './finance-reconciliation.service';

function parseDate(raw: string | undefined, fallback: Date): Date {
  if (!raw) return fallback;
  const d = new Date(raw);
  return Number.isNaN(d.getTime()) ? fallback : d;
}

/**
 * Finance reconciliation console (ADR-029). ADMIN/SUPER_ADMIN only. Detect + triage
 * discrepancies, assign, resolve (never auto-correct financial records), export CSV,
 * and see the aging report.
 */
@ApiTags('admin-finance')
@ApiBearerAuth()
@Roles(Role.ADMIN, Role.SUPER_ADMIN)
@RequiresAdmin(AdminPermission.FINANCE_READ)
@Controller('admin/payments/finance')
export class FinanceReconciliationController {
  constructor(private readonly finance: FinanceReconciliationService) {}

  @Post('detect')
  @ApiOperation({ summary: 'Run discrepancy detection over a window (admin).' })
  detect(@Query('from') from?: string, @Query('to') to?: string) {
    const toDate = parseDate(to, new Date());
    const fromDate = parseDate(from, new Date(toDate.getTime() - 24 * 3600 * 1000));
    return this.finance.detect(fromDate, toDate);
  }

  @Get('discrepancies')
  @ApiOperation({ summary: 'List discrepancies (admin).' })
  list(@Query('status') status?: string, @Query('type') type?: string) {
    return this.finance.list({ status, type });
  }

  @Get('discrepancies.csv')
  @Header('Content-Type', 'text/csv')
  @Header('Content-Disposition', 'attachment; filename="discrepancies.csv"')
  @ApiOperation({ summary: 'Export discrepancies as CSV (admin).' })
  csv(@Query('status') status?: string, @Query('type') type?: string) {
    return this.finance.csv({ status, type });
  }

  @Get('aging')
  @ApiOperation({ summary: 'Aging report of open discrepancies (admin).' })
  aging() {
    return this.finance.aging();
  }

  @Post('discrepancies/:id/assign')
  assign(
    @CurrentUser() user: RequestUser,
    @Ip() ip: string,
    @Param('id') id: string,
    @Body(new ZodValidationPipe(z.object({ userId: z.string().min(1) }))) body: { userId: string },
  ) {
    return this.finance.assign(id, body.userId, { userId: user.id, ip });
  }

  @Post('discrepancies/:id/resolve')
  resolve(
    @CurrentUser() user: RequestUser,
    @Ip() ip: string,
    @Param('id') id: string,
    @Body(new ZodValidationPipe(z.object({ notes: z.string().min(1) }))) body: { notes: string },
  ) {
    return this.finance.resolve(id, body.notes, { userId: user.id, ip });
  }

  @Post('discrepancies/:id/ignore')
  ignore(
    @CurrentUser() user: RequestUser,
    @Ip() ip: string,
    @Param('id') id: string,
    @Body(new ZodValidationPipe(z.object({ notes: z.string().min(1) }))) body: { notes: string },
  ) {
    return this.finance.ignore(id, body.notes, { userId: user.id, ip });
  }
}
