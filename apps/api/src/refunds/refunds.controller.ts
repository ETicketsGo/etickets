import { Body, Controller, Get, Param, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { z } from 'zod';
import { RefundStatus, Role } from '@eticketsgo/shared-types';
import {
  paginationSchema,
  refundRequestSchema,
  type RefundRequestInput,
} from '@eticketsgo/validation';
import { RefundsService } from './refunds.service';
import { AdminPermission } from '@eticketsgo/shared-types';
import { CurrentUser, RequiresAdmin, Roles, type RequestUser } from '../common/decorators';
import { ZodValidationPipe } from '../common/zod-validation.pipe';

@ApiTags('refunds')
@ApiBearerAuth()
@Controller('refunds')
export class RefundsController {
  constructor(private readonly refunds: RefundsService) {}

  @Post()
  @ApiOperation({ summary: 'Request a refund for an eligible booking.' })
  request(
    @CurrentUser() user: RequestUser,
    @Body(new ZodValidationPipe(refundRequestSchema)) body: RefundRequestInput,
  ) {
    return this.refunds.request(user, body);
  }

  @Get('booking/:bookingId')
  @ApiOperation({ summary: 'List refunds for a booking (owner/admin).' })
  listForBooking(@CurrentUser() user: RequestUser, @Param('bookingId') bookingId: string) {
    return this.refunds.listForBookingOwner(user, bookingId);
  }

  @Post(':id/process')
  @Roles(Role.ORGANIZER_OWNER, Role.ADMIN, Role.SUPER_ADMIN)
  /*
    Deliberately NOT decorated with a required capability.

    This route serves two audiences. An ORGANIZER_OWNER refunding their own customer is not
    exercising a platform capability — it is their money and their decision, checked by
    tenancy. A decorator applies to every caller, so gating the route locked organizers out
    of their own refund console; the e2e caught it.

    The requirement belongs where the two audiences are already told apart, which is inside
    the service. See `RefundsService.process`.
  */
  @ApiOperation({ summary: 'Approve or reject a refund.' })
  process(
    @CurrentUser() user: RequestUser,
    @Param('id') id: string,
    @Body(new ZodValidationPipe(z.object({ decision: z.enum(['APPROVE', 'REJECT']) })))
    body: { decision: 'APPROVE' | 'REJECT' },
  ) {
    return this.refunds.process(user, id, body.decision);
  }
}

@ApiTags('organizer')
@ApiBearerAuth()
@Controller('organizations/:organizationId/refunds')
export class OrganizationRefundsController {
  constructor(private readonly refunds: RefundsService) {}

  @Get()
  @Roles(Role.ORGANIZER_OWNER, Role.ORGANIZER_MANAGER, Role.ADMIN, Role.SUPER_ADMIN)
  @ApiOperation({ summary: "List one organization's refunds." })
  list(
    @CurrentUser() user: RequestUser,
    @Param('organizationId') organizationId: string,
    @Query(
      new ZodValidationPipe(
        paginationSchema.extend({ status: z.nativeEnum(RefundStatus).optional() }),
      ),
    )
    q: { page: number; pageSize: number; status?: RefundStatus },
  ) {
    return this.refunds.listForOrganization(user, organizationId, q);
  }
}

@ApiTags('admin')
@ApiBearerAuth()
@Roles(Role.ADMIN, Role.SUPER_ADMIN)
@RequiresAdmin(AdminPermission.REFUND_REVIEW)
@Controller('admin/refunds')
export class AdminRefundsController {
  constructor(private readonly refunds: RefundsService) {}

  @Get()
  @ApiOperation({ summary: 'List refunds for processing (admin).' })
  list(
    @Query(
      new ZodValidationPipe(
        paginationSchema.extend({ status: z.nativeEnum(RefundStatus).optional() }),
      ),
    )
    q: {
      page: number;
      pageSize: number;
      status?: RefundStatus;
    },
  ) {
    return this.refunds.adminList(q.status, q.page, q.pageSize);
  }
}
