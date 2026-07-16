import { Body, Controller, Get, Post } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { z } from 'zod';
import type { WalletProvider } from '@eticketsgo/shared-types';
import { WalletPassService } from './wallet-pass.service';
import { CurrentUser, type RequestUser } from '../common/decorators';
import { ZodValidationPipe } from '../common/zod-validation.pipe';

const generateSchema = z.object({
  ticketId: z.string().min(1),
  provider: z.enum(['apple', 'google']),
});

/**
 * Wallet-pass endpoints (ADR-035 wallet sandbox). Read-only status + a rate-limited,
 * audited generate that projects an existing valid ticket into a provider pass
 * descriptor. Responses never contain secret material; generation fails closed.
 */
@ApiTags('wallet')
@ApiBearerAuth()
@Controller('wallet')
export class WalletPassController {
  constructor(private readonly wallet: WalletPassService) {}

  @Get('providers')
  @ApiOperation({ summary: 'Wallet provider availability (non-secret status only).' })
  providers() {
    return this.wallet.providersStatus();
  }

  @Post('passes')
  // Bounded generation rate per user/IP — pass generation is comparatively expensive
  // and must not be abusable. Independent of the auth throttle.
  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  @ApiOperation({ summary: 'Generate a wallet pass for a ticket (fails closed; audited).' })
  generate(
    @CurrentUser() user: RequestUser,
    @Body(new ZodValidationPipe(generateSchema))
    body: { ticketId: string; provider: WalletProvider },
  ) {
    return this.wallet.generate(user, body.ticketId, body.provider);
  }
}
