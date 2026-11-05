import { Body, Controller, Get, Param, Patch, Post, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { AdminPermission, Role } from '@eticketsgo/shared-types';
import {
  listFeedbackSchema,
  submitFeedbackSchema,
  updateFeedbackSchema,
  type ListFeedbackInput,
  type SubmitFeedbackInput,
  type UpdateFeedbackInput,
} from '@eticketsgo/validation';
import { SupportService } from './support.service';
import { OptionalJwtAuthGuard } from './optional-jwt-auth.guard';
import { RequiresAdmin, CurrentUser, Public, Roles, type RequestUser } from '../common/decorators';
import { ZodValidationPipe } from '../common/zod-validation.pipe';
import { RequiresHumanCheck } from '../human-check/human-check.guard';
import { countryFilterField } from '../admin/country-filter';
import { dayField, idField, refineDateOrder, type ListFilters } from '../admin/list-filters';

/**
 * Ten messages a minute per client, on top of the application-wide limit.
 *
 * Every Contact or Help message is now mailed to the support inbox and acknowledged to the
 * address it gives, so this route sends email on an anonymous caller's behalf. The general
 * limit (120 a minute) is set for page loads, not for that. Ten is far more than a person
 * writing to support needs, and a script hitting it is stopped at the first minute.
 *
 * Env-overridable through the same variable as the credential routes, ONLY so an e2e run that
 * posts many messages from one address does not trip it. Deployed environments leave it unset.
 */
const SUPPORT_THROTTLE = {
  default: { limit: Number(process.env.AUTH_THROTTLE_LIMIT ?? 10), ttl: 60_000 },
};

@ApiTags('support')
@Controller('support')
export class SupportController {
  constructor(private readonly support: SupportService) {}

  @Post()
  @Public()
  @Throttle(SUPPORT_THROTTLE)
  @UseGuards(OptionalJwtAuthGuard)
  @RequiresHumanCheck('support')
  @ApiOperation({
    summary: 'Submit support/feedback (contact, bug, feature, general, CSAT). Public.',
  })
  submit(
    @CurrentUser() user: RequestUser | undefined,
    @Body(new ZodValidationPipe(submitFeedbackSchema)) body: SubmitFeedbackInput,
  ) {
    return this.support.submit(user, body);
  }
}

@ApiTags('admin')
@ApiBearerAuth()
@Roles(Role.ADMIN, Role.SUPER_ADMIN)
@RequiresAdmin(AdminPermission.BOOKING_READ)
@Controller('admin/support')
export class AdminSupportController {
  constructor(private readonly support: SupportService) {}

  @Get()
  @ApiOperation({ summary: 'List/search support submissions (admin).' })
  list(
    @Query(
      new ZodValidationPipe(
        listFeedbackSchema
          .extend({
            // Market (the organizer's registered country), event and a UTC day window.
            country: countryFilterField,
            eventId: idField,
            from: dayField,
            to: dayField,
          })
          .superRefine(refineDateOrder),
      ),
    )
    q: ListFeedbackInput & Omit<ListFilters, 'organizationId'>,
  ) {
    return this.support.list(q);
  }

  @Get('complaints/:organizationId')
  @ApiOperation({ summary: 'Open and total complaint counts for one organizer (admin).' })
  complaintCounts(@Param('organizationId') organizationId: string) {
    return this.support.complaintCounts(organizationId);
  }

  /*
    Seeing submissions is BOOKING_READ, the class guard and the support desk's floor. Changing a
    status is a write - closing a complaint changes the open count that decides whether an
    organizer keeps selling - so it needs SUPPORT_MANAGE. It used to inherit BOOKING_READ.
  */
  @Patch(':id')
  @RequiresAdmin(AdminPermission.SUPPORT_MANAGE)
  @ApiOperation({ summary: 'Update a support submission status (admin).' })
  update(
    @CurrentUser() user: RequestUser,
    @Param('id') id: string,
    @Body(new ZodValidationPipe(updateFeedbackSchema)) body: UpdateFeedbackInput,
  ) {
    return this.support.updateStatus(id, body, user.id);
  }
}
