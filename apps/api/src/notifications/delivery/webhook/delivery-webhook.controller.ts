import { Body, Controller, Headers, Param, Post, Req } from '@nestjs/common';
import type { RawBodyRequest } from '@nestjs/common';
import type { Request } from 'express';
import { ConfigService } from '@nestjs/config';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { Public } from '../../../common/decorators';
import { DeliveryWebhookService } from './delivery-webhook.service';

/**
 * Where providers tell us what happened to a message.
 *
 * ── WHY PUBLIC, AND WHAT STANDS IN FOR AUTHENTICATION ──────────────────────────────
 * A provider cannot hold a bearer token, so these are unauthenticated in the ordinary sense
 * and every one of them proves the caller some other way — an HMAC signature where the
 * provider publishes one, a shared secret in the path where it does not. Nothing is written
 * before that check passes, because what these endpoints can do is SUPPRESS a destination,
 * and an unverified suppression endpoint is a way to stop somebody receiving their tickets.
 *
 * ── WHY THE SECRET IS IN THE PATH ──────────────────────────────────────────────────
 * For MSG91 and SES it is the only thing the provider will carry: both register a callback
 * URL in a dashboard and neither offers a custom header. It is stated as weaker than a
 * signature in the ADR rather than presented as equivalent.
 */
@ApiTags('notifications')
@Controller('notifications/webhooks')
export class DeliveryWebhookController {
  constructor(
    private readonly webhooks: DeliveryWebhookService,
    private readonly config: ConfigService,
  ) {}

  @Public()
  @Post('twilio')
  @ApiOperation({ summary: 'Twilio SMS status callback (HMAC-SHA1 signed).' })
  async twilio(@Req() req: Request, @Body() body: Record<string, unknown>) {
    /*
      The URL Twilio actually called is part of what it signed, so it has to be the PUBLIC
      one. Behind a load balancer, Express reconstructs the internal host and the signature
      never matches — which is why the base is configuration rather than inference.
    */
    const base = (this.config.get<string>('PUBLIC_API_URL') ?? '').replace(/\/+$/, '');
    return this.webhooks.twilio({
      url: `${base}${req.originalUrl}`,
      body,
      signature: req.header('x-twilio-signature') ?? '',
    });
  }

  @Public()
  @Post('whatsapp/cloud')
  @ApiOperation({ summary: 'Meta WhatsApp Cloud status callback (HMAC-SHA256 signed).' })
  async metaCloud(@Req() req: RawBodyRequest<Request>) {
    // Meta signs the RAW bytes. Re-serialising a parsed body is not byte-identical, so the
    // signature would fail on any payload whose key order or number formatting differs.
    return this.webhooks.metaCloud({
      rawBody: req.rawBody ? req.rawBody.toString('utf8') : '',
      signature: req.header('x-hub-signature-256') ?? '',
    });
  }

  @Public()
  @Post('msg91/:secret')
  @ApiOperation({ summary: 'MSG91 delivery report (shared-secret URL; no published signature).' })
  async msg91(@Param('secret') secret: string, @Body() body: Record<string, unknown>) {
    return this.webhooks.msg91({ secret, body });
  }

  @Public()
  @Post('ses/:secret')
  @ApiOperation({ summary: 'SES delivery/bounce/complaint via SNS (shared-secret URL).' })
  async ses(
    @Param('secret') secret: string,
    @Headers() headers: Record<string, string>,
    @Body() body: Record<string, unknown>,
  ) {
    return this.webhooks.ses({ secret, headers, body });
  }
}
