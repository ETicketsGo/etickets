import { Body, Controller, Delete, Get, Param, Patch, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { z } from 'zod';
import { AdminPermission, MovieStatus, Role } from '@eticketsgo/shared-types';
import { paginationSchema } from '@eticketsgo/validation';
import { AdminService } from './admin.service';
import { TaxRulesService } from './tax-rules.service';
import { MoviesService } from '../movies/movies.service';
import { RequiresAdmin, CurrentUser, Roles } from '../common/decorators';
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

/*
  A tax rule as an administrator types it.

  Rates are BASIS POINTS — 1800 is 18%, not 1800%. Stated in the message on the bound rather
  than only in a doc comment, because a form that accepts 18 and charges 0.18% is a mistake
  nobody notices until a return is filed.
*/
const taxRuleBodySchema = z.object({
  label: z.string().trim().min(1).max(40),
  rateBasisPoints: z.number().int().min(0).max(10_000, 'Basis points: 1800 = 18%. Max 10000.'),
  appliesTo: z.enum(['TICKETS', 'FEES', 'TICKETS_AND_FEES']),
  /** Rules sharing a group are alternatives; one wins. Empty means it always applies. */
  taxGroup: z.string().trim().max(40).optional(),
  country: z.string().trim().max(60).optional(),
  region: z.string().trim().max(60).optional(),
  currency: z.string().trim().max(3).optional(),
  category: z.string().trim().max(60).optional(),
  /** Band bounds are on the price of ONE ticket, inclusive, in minor units. */
  minUnitMinor: z.number().int().min(0).nullable().optional(),
  maxUnitMinor: z.number().int().min(0).nullable().optional(),
  inclusive: z.boolean().optional(),
  split: z.enum(['NONE', 'CGST_SGST']).optional(),
  priority: z.number().int().min(0).max(1000).optional(),
  effectiveFrom: z.coerce.date().nullable().optional(),
  effectiveTo: z.coerce.date().nullable().optional(),
  active: z.boolean().optional(),
});
type TaxRuleBody = z.infer<typeof taxRuleBodySchema>;

const taxRulePatchSchema = taxRuleBodySchema
  .partial()
  .refine((v) => Object.keys(v).length > 0, { message: 'Provide at least one field to update.' });
type TaxRulePatchBody = z.infer<typeof taxRulePatchSchema>;

/** Closing one rate and opening the next, at one instant. */
const taxRuleSupersedeSchema = z.object({
  rateBasisPoints: z.number().int().min(0).max(10_000),
  effectiveFrom: z.coerce.date(),
  label: z.string().trim().min(1).max(40).optional(),
});
type TaxRuleSupersedeBody = z.infer<typeof taxRuleSupersedeSchema>;

@ApiTags('admin')
@ApiBearerAuth()
@Roles(Role.ADMIN, Role.SUPER_ADMIN)
@RequiresAdmin(AdminPermission.BOOKING_READ)
@Controller('admin')
export class AdminController {
  constructor(
    private readonly admin: AdminService,
    private readonly movies: MoviesService,
    // Underscored because `taxRules` is the route handler's name on this class.
    private readonly taxRules_: TaxRulesService,
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

  /*
    Tax rules.

    Separate service from the fee rules above because the editing RULES are different: a fee
    band can be corrected in place, a live tax rate cannot — it has to be superseded so the
    old rate stays on file. See TaxRulesService for why that matters.
  */
  @Get('tax-rules')
  @ApiOperation({ summary: 'List tax rules, with whether each is in force right now (admin).' })
  taxRules() {
    return this.taxRules_.list();
  }

  @Post('tax-rules')
  @ApiOperation({ summary: 'Create a tax rule. Inactive unless explicitly activated (admin).' })
  createTaxRule(
    @CurrentUser() user: { id: string },
    @Body(new ZodValidationPipe(taxRuleBodySchema)) body: TaxRuleBody,
  ) {
    return this.taxRules_.create(user.id, body);
  }

  @Patch('tax-rules/:id')
  @ApiOperation({
    summary: 'Update a draft tax rule, or switch one on/off. A live rate must be superseded.',
  })
  updateTaxRule(
    @CurrentUser() user: { id: string },
    @Param('id') id: string,
    @Body(new ZodValidationPipe(taxRulePatchSchema)) body: TaxRulePatchBody,
  ) {
    return this.taxRules_.update(user.id, id, body);
  }

  @Post('tax-rules/:id/supersede')
  @ApiOperation({ summary: 'Close a rule at a date and open its successor at a new rate.' })
  supersedeTaxRule(
    @CurrentUser() user: { id: string },
    @Param('id') id: string,
    @Body(new ZodValidationPipe(taxRuleSupersedeSchema)) body: TaxRuleSupersedeBody,
  ) {
    return this.taxRules_.supersede(user.id, id, body);
  }

  @Delete('tax-rules/:id')
  @ApiOperation({ summary: 'Delete a tax rule that is switched off (admin).' })
  deleteTaxRule(@CurrentUser() user: { id: string }, @Param('id') id: string) {
    return this.taxRules_.remove(user.id, id);
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
