import { Controller, Get, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { z } from 'zod';
import { Role } from '@eticketsgo/shared-types';
import { paginationSchema } from '@eticketsgo/validation';
import { AdminService } from './admin.service';
import { Roles } from '../common/decorators';
import { ZodValidationPipe } from '../common/zod-validation.pipe';

@ApiTags('admin')
@ApiBearerAuth()
@Roles(Role.ADMIN, Role.SUPER_ADMIN)
@Controller('admin')
export class AdminController {
  constructor(private readonly admin: AdminService) {}

  @Get('bookings')
  @ApiOperation({ summary: 'List/search all bookings (admin).' })
  bookings(
    @Query(
      new ZodValidationPipe(
        paginationSchema.extend({ status: z.string().optional(), q: z.string().optional() }),
      ),
    )
    q: {
      page: number;
      pageSize: number;
      status?: string;
      q?: string;
    },
  ) {
    return this.admin.bookings(q);
  }

  @Get('payments')
  @ApiOperation({ summary: 'List payments (admin).' })
  payments(
    @Query(new ZodValidationPipe(paginationSchema.extend({ status: z.string().optional() })))
    q: {
      page: number;
      pageSize: number;
      status?: string;
    },
  ) {
    return this.admin.payments(q);
  }

  @Get('fee-rules')
  @ApiOperation({ summary: 'List platform fee rules (admin).' })
  feeRules() {
    return this.admin.feeRules();
  }
}
