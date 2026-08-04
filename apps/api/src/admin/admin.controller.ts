import { Body, Controller, Get, Param, Patch, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { z } from 'zod';
import { MovieStatus, Role } from '@eticketsgo/shared-types';
import { paginationSchema } from '@eticketsgo/validation';
import { AdminService } from './admin.service';
import { MoviesService } from '../movies/movies.service';
import { CurrentUser, Roles } from '../common/decorators';
import { ZodValidationPipe } from '../common/zod-validation.pipe';

/**
 * Editable fields of a fee rule. `currency` is intentionally absent: the amounts are integer
 * minor units, so moving a rule between currencies would silently reinterpret ₹5 as $5.
 * `maxMinor` accepts null to mean "and above" for the top band, so `.nullable()` is required
 * and is distinct from omitting the key (which leaves the value unchanged).
 */
const feeRulePatchSchema = z
  .object({
    label: z.string().trim().min(1).max(60).optional(),
    minMinor: z.number().int().min(0).optional(),
    maxMinor: z.number().int().min(0).nullable().optional(),
    feeMinor: z.number().int().min(0).optional(),
    active: z.boolean().optional(),
  })
  .refine((v) => Object.keys(v).length > 0, { message: 'Provide at least one field to update.' });

type FeeRulePatch = z.infer<typeof feeRulePatchSchema>;

/**
 * A new band. `currency` IS required here (unlike the patch, where it is immutable) — a band
 * only means anything relative to the other bands in its currency, and the amounts are minor
 * units, so the currency has to be stated rather than guessed.
 */
const feeRuleCreateSchema = z.object({
  currency: z
    .string()
    .trim()
    .regex(/^[A-Z]{3}$/, 'Use a 3-letter ISO currency code, e.g. INR or USD.'),
  label: z.string().trim().min(1).max(60),
  minMinor: z.number().int().min(0),
  maxMinor: z.number().int().min(0).nullable(),
  feeMinor: z.number().int().min(0),
  active: z.boolean().optional(),
});

type FeeRuleCreate = z.infer<typeof feeRuleCreateSchema>;

@ApiTags('admin')
@ApiBearerAuth()
@Roles(Role.ADMIN, Role.SUPER_ADMIN)
@Controller('admin')
export class AdminController {
  constructor(
    private readonly admin: AdminService,
    private readonly movies: MoviesService,
  ) {}

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

  @Post('fee-rules')
  @ApiOperation({ summary: 'Create a platform fee-rule band (admin).' })
  createFeeRule(
    @CurrentUser() user: { id: string },
    @Body(new ZodValidationPipe(feeRuleCreateSchema)) body: FeeRuleCreate,
  ) {
    return this.admin.createFeeRule(user.id, body);
  }

  @Patch('fee-rules/:id')
  @ApiOperation({ summary: 'Update a platform fee rule (admin).' })
  updateFeeRule(
    @CurrentUser() user: { id: string },
    @Param('id') id: string,
    @Body(new ZodValidationPipe(feeRulePatchSchema)) body: FeeRulePatch,
  ) {
    return this.admin.updateFeeRule(user.id, id, body);
  }

  @Get('movies')
  @ApiOperation({ summary: 'List movies across all organizations (admin).' })
  moviesList(
    @Query(
      new ZodValidationPipe(
        paginationSchema.extend({
          status: z.nativeEnum(MovieStatus).optional(),
          q: z.string().optional(),
        }),
      ),
    )
    q: {
      page: number;
      pageSize: number;
      status?: MovieStatus;
      q?: string;
    },
  ) {
    return this.movies.adminList(q.status, q.q, q.page, q.pageSize);
  }
}
