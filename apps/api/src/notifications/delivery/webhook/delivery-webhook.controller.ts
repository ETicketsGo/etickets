import {
  Body,
  Controller,
  Get,
  Header,
  Headers,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Query,
  Req,
} from '@nestjs/common';
import type { RawBodyRequest } from '@nestjs/common';
import type { Request } from 'express';
import { ConfigService } from '@nestjs/config';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { SkipThrottle } from '@nestjs/throttler';
import { Public } from '../../../common/decorators';
import { AppException, ErrorCodes } from '../../../common/errors';
import { safeEqual } from './delivery-webhook.signatures';
import { DeliveryWebhookService } from './delivery-webhook.service';

/** A TwiML response that does nothing: no reply, no redirect. */
export const EMPTY_TWIML = '<?xml version="1.0" encoding="UTF-8"?><Response></Response>';

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
 *
 * ── WHY THE PER-IP RATE LIMIT DOES NOT APPLY ───────────────────────────────────────
 * The global limit is 120 requests a minute per client IP, and a provider is ONE client: a bulk
 * send of a few hundred SMS produces a few hundred Twilio status callbacks from a handful of
 * Twilio addresses within seconds. Past the limit they got 429, and Twilio does not retry a
 * status callback, so those messages were never marked delivered or failed. The limit exists to
 * slow down people guessing credentials; every route here authenticates by signature or path
 * secret before it writes anything, so it protects nothing here and loses real events.
 */
@ApiTags('notifications')
@SkipThrottle()
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

  /**
   * The Messaging Service's incoming-message webhook: Advanced Opt-Out keywords only.
   *
   * Answers with EMPTY TwiML. Twilio has already replied to the sender in their own language;
   * a `<Message>` here would text them a second time, and anything that is not TwiML is logged
   * by Twilio as an application error. Signed exactly like the status callback.
   */
  @Public()
  @Post('twilio/inbound')
  @HttpCode(HttpStatus.OK)
  @Header('Content-Type', 'text/xml')
  @ApiOperation({
    summary: 'Twilio inbound SMS: Advanced Opt-Out STOP/START/HELP only (HMAC-SHA1 signed).',
  })
  async twilioInbound(@Req() req: Request, @Body() body: Record<string, unknown>) {
    const base = (this.config.get<string>('PUBLIC_API_URL') ?? '').replace(/\/+$/, '');
    await this.webhooks.twilioInbound({
      url: `${base}${req.originalUrl}`,
      body,
      signature: req.header('x-twilio-signature') ?? '',
    });
    return EMPTY_TWIML;
  }

  /**
   * Meta's subscription challenge.
   *
   * ── WHY A GET ENDPOINT EXISTS AT ALL ───────────────────────────────────────────────
   * Meta will not activate a webhook subscription until it has GET this URL with a token it
   * was given in the app dashboard and received that request's `hub.challenge` back. Without
   * it the subscription simply cannot be created — the POST handler below is perfectly
   * correct and is never called, because Meta never starts sending.
   *
   * ── WHY IT COMPARES IN CONSTANT TIME AND ECHOES NOTHING OTHERWISE ──────────────────
   * The verify token is a shared secret. A naive `===` leaks its length and content through
   * timing, and echoing the challenge before checking the token would turn this into an open
   * reflector for anybody who found the URL.
   */
  @Public()
  @Get('whatsapp/cloud')
  @ApiOperation({ summary: 'Meta webhook subscription challenge (hub.verify_token).' })
  verifyMetaSubscription(
    @Query('hub.mode') mode?: string,
    @Query('hub.verify_token') token?: string,
    @Query('hub.challenge') challenge?: string,
  ) {
    const expected = this.config.get<string>('WHATSAPP_VERIFY_TOKEN') ?? '';
    if (mode !== 'subscribe' || !expected || !token || !safeEqual(expected, token)) {
      throw new AppException(
        ErrorCodes.UNAUTHORIZED,
        'Verification failed.',
        HttpStatus.UNAUTHORIZED,
      );
    }
    // Meta expects the raw challenge string, not JSON.
    return challenge ?? '';
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
