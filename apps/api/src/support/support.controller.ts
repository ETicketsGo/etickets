import { Body, Controller, Get, Param, Patch, Post, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
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
import { countryFilterField } from '../admin/country-filter';
import { dayField, idField, refineDateOrder, type ListFilters } from '../admin/list-filters';

@ApiTags('support')
@Controller('support')
export class SupportController {
  constructor(private readonly support: SupportService) {}

  @Post()
  @Public()
  @UseGuards(OptionalJwtAuthGuard)
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

  @Patch(':id')
  @ApiOperation({ summary: 'Update a support submission status (admin).' })
  update(
    @Param('id') id: string,
    @Body(new ZodValidationPipe(updateFeedbackSchema)) body: UpdateFeedbackInput,
  ) {
    return this.support.updateStatus(id, body);
  }
}
