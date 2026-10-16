import { Body, Controller, Get, Param, Patch, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { z } from 'zod';
import { AdminPermission, Role } from '@eticketsgo/shared-types';
import {
  cinemaLegalTypeSchema,
  paginationSchema,
  type CinemaLegalTypeInput,
} from '@eticketsgo/validation';
import { CurrentUser, RequiresAdmin, Roles, type RequestUser } from '../common/decorators';
import { ZodValidationPipe } from '../common/zod-validation.pipe';
import { CinemaLegalTypeService } from './cinema-legal-type.service';

const listQuery = paginationSchema.extend({ q: z.string().trim().max(120).optional() });

/**
 * The platform team's view of every cinema's legal type (local body, format, cooling).
 *
 * Platform configuration, guarded like the cinema pricing policies it feeds: reading needs
 * PLATFORM_CONFIG_READ and changing needs PLATFORM_CONFIG, each declared on its handler (a
 * handler's `@RequiresAdmin` replaces the class's, and the class's is the strictest on purpose
 * so a route added here without one is refused rather than opened).
 */
@ApiTags('admin')
@ApiBearerAuth()
@Roles(Role.ADMIN, Role.SUPER_ADMIN)
@RequiresAdmin(AdminPermission.PLATFORM_CONFIG)
@Controller('admin/cinemas')
export class AdminCinemasController {
  constructor(private readonly legalType: CinemaLegalTypeService) {}

  @Get()
  @RequiresAdmin(AdminPermission.PLATFORM_CONFIG_READ)
  @ApiOperation({ summary: 'Every cinema with where it is and its legal type (admin).' })
  list(@Query(new ZodValidationPipe(listQuery)) q: z.infer<typeof listQuery>) {
    return this.legalType.list(q);
  }

  @Patch(':id/legal-type')
  @RequiresAdmin(AdminPermission.PLATFORM_CONFIG)
  @ApiOperation({ summary: "Set a cinema's legal type, with a reason. Audited (admin)." })
  setLegalType(
    @CurrentUser() admin: RequestUser,
    @Param('id') id: string,
    @Body(new ZodValidationPipe(cinemaLegalTypeSchema)) body: CinemaLegalTypeInput,
  ) {
    return this.legalType.set(admin.id, id, body);
  }
}
