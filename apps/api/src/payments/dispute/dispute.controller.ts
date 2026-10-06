import { Controller, Get } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { AdminPermission, Role } from '@eticketsgo/shared-types';
import { RequiresAdmin, Roles } from '../../common/decorators';
import { DisputeService } from './dispute.service';

/**
 * The chargeback queue.
 *
 * ── WHY A ROUTE WAS MISSING ────────────────────────────────────────────────────────
 * `DisputeService` has mirrored every provider chargeback since Stripe Connect went in:
 * amount, reason, the organizer it came from, and `evidenceDueBy` - the date the provider
 * stops accepting an answer. It blocked the organizer's proceeds and notified every admin.
 * It had no controller, so none of it could be looked at. The platform knew a chargeback was
 * due on Thursday and had no screen that could say so.
 *
 * Read-only on purpose: evidence is submitted in the provider's own dashboard and the outcome
 * returns through the webhook that already exists. See `DisputeService.listOpen`.
 *
 * `FINANCE_READ` is the right capability - this is money owed and at risk, which is what that
 * capability describes. It is deliberately not `PAYMENT_ADMIN`: reading the queue changes no
 * configuration, and the finance duty is the one that has to act on it.
 */
@ApiTags('admin')
@ApiBearerAuth()
@Roles(Role.ADMIN, Role.SUPER_ADMIN)
@RequiresAdmin(AdminPermission.FINANCE_READ)
@Controller('admin/disputes')
export class DisputeController {
  constructor(private readonly disputes: DisputeService) {}

  @Get()
  @ApiOperation({
    summary: 'Open chargebacks, soonest deadline first, with the amount at risk per currency.',
  })
  async open() {
    return this.disputes.listOpen();
  }
}
