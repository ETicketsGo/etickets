import { Controller, Get, Header, Headers, HttpStatus, Param, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { z } from 'zod';
import { Role } from '@eticketsgo/shared-types';
import { paginationSchema } from '@eticketsgo/validation';
import { resolveLocale } from '@eticketsgo/i18n';
import { ReceiptsService } from './receipts.service';
import { renderReceiptHtml } from './receipt-html';
import { PrismaService } from '../prisma/prisma.service';
import { OrgAccessService } from '../tenancy/org-access.service';
import { AppException, ErrorCodes } from '../common/errors';
import { CurrentUser, Roles, type RequestUser } from '../common/decorators';
import { ZodValidationPipe } from '../common/zod-validation.pipe';

const listQuerySchema = paginationSchema.extend({
  from: z.coerce.date().optional(),
  to: z.coerce.date().optional(),
});

@ApiTags('receipts')
@ApiBearerAuth()
@Controller('receipts')
export class ReceiptsController {
  constructor(
    private readonly receipts: ReceiptsService,
    private readonly prisma: PrismaService,
    private readonly access: OrgAccessService,
  ) {}

  /**
   * Who may see a document: the buyer whose booking it is, or a member of the selling
   * organization (platform admins pass through `assertMember`).
   *
   * A guest booking has no `userId`, so the only identity attached to it is the buyer email.
   * Those documents are reachable through the guest booking flow rather than here — this
   * endpoint requires a signed-in identity and will not match an email against a session.
   */
  private async assertMayView(user: RequestUser, receiptId: string) {
    const { receipt, document } = await this.receipts.document(receiptId);
    const booking = await this.prisma.booking.findUnique({
      where: { id: receipt.bookingId },
      select: { userId: true },
    });
    if (booking?.userId && booking.userId === user.id) return document;
    await this.access.assertMember(user, receipt.organizationId);
    return document;
  }

  @Get('booking/:bookingId')
  @ApiOperation({ summary: 'List the documents issued for a booking.' })
  async listForBooking(@CurrentUser() user: RequestUser, @Param('bookingId') bookingId: string) {
    const booking = await this.prisma.booking.findUnique({
      where: { id: bookingId },
      select: { userId: true, organizationId: true },
    });
    if (!booking) {
      throw new AppException(ErrorCodes.NOT_FOUND, 'Booking not found.', HttpStatus.NOT_FOUND);
    }
    if (booking.userId !== user.id) {
      await this.access.assertMember(user, booking.organizationId);
    }
    return this.receipts.listForBooking(bookingId);
  }

  @Get(':id')
  @ApiOperation({ summary: 'Fetch one issued document as JSON.' })
  async get(@CurrentUser() user: RequestUser, @Param('id') id: string) {
    return this.assertMayView(user, id);
  }

  @Get(':id/html')
  @Header('Content-Type', 'text/html; charset=utf-8')
  // A financial document must not be cached by a shared proxy: it names a buyer and an
  // amount, and the URL alone is not an authorization.
  @Header('Cache-Control', 'private, no-store')
  @ApiOperation({ summary: 'Render one issued document as printable HTML.' })
  async html(
    @CurrentUser() user: RequestUser,
    @Param('id') id: string,
    @Query('locale') localeParam?: string,
    @Headers('accept-language') acceptLanguage?: string,
  ) {
    const document = await this.assertMayView(user, id);
    /*
      Which language this document is written in, in the order that respects the reader.

      The `?locale=` parameter exists because this URL is opened from a page that already
      knows — the storefront links to it from a confirmation that is itself in French, and it
      would be absurd to render the receipt in English because the browser header disagreed.
      Then the account's stored preference, then the header, then the default.

      Deliberately re-derived per request rather than frozen onto the document when it was
      issued: a receipt is a rendering of stored facts, not a stored rendering, so somebody
      who switches language can reprint last month's receipt in the language they now read.
      The AMOUNTS come from the document and never move.
    */
    const stored = await this.prisma.user
      .findUnique({ where: { id: user.id }, select: { locale: true } })
      .catch(() => null);
    const locale = resolveLocale({
      stored: localeParam ?? stored?.locale ?? null,
      acceptLanguage: acceptLanguage ?? null,
    });
    return renderReceiptHtml(document, locale);
  }
}

@ApiTags('organizer')
@ApiBearerAuth()
@Controller('organizations/:organizationId/receipts')
export class OrganizationReceiptsController {
  constructor(
    private readonly receipts: ReceiptsService,
    private readonly access: OrgAccessService,
  ) {}

  @Get()
  @Roles(Role.ORGANIZER_OWNER, Role.ORGANIZER_MANAGER, Role.ADMIN, Role.SUPER_ADMIN)
  @ApiOperation({ summary: "An organization's issued receipts, invoices and credit notes." })
  async list(
    @CurrentUser() user: RequestUser,
    @Param('organizationId') organizationId: string,
    @Query(new ZodValidationPipe(listQuerySchema))
    query: z.infer<typeof listQuerySchema>,
  ) {
    await this.access.assertMember(user, organizationId);
    return this.receipts.listForOrganization(organizationId, query);
  }
}
