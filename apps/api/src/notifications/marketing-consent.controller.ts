import { Body, Controller, Get, Ip, Headers, Put } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { z } from 'zod';
import { MarketingConsentService } from './marketing-consent.service';
import { CurrentUser, type RequestUser } from '../common/decorators';
import { ZodValidationPipe } from '../common/zod-validation.pipe';

/**
 * The consent scopes a person can decide about.
 *
 * ── WHY `whatsapp:transactional` LIVES HERE ────────────────────────────────────────
 * Because it is the same kind of record — a subject, a channel, granted or withdrawn, when,
 * and how it was obtained — kept append-only so a withdrawal is a new row rather than an
 * edit. A second table because the model has "marketing" in its name would give the platform
 * two places to look for one person's answer and two things to produce for a data-subject
 * request.
 *
 * What it is NOT is the same QUESTION. `whatsapp` means "you may sell to me on WhatsApp";
 * `whatsapp:transactional` means "you may use WhatsApp to tell me about my own booking".
 * Somebody who declines offers has not asked to stop receiving their tickets, and a screen
 * that bundles the two into one checkbox makes that mistake on their behalf.
 */
const CONSENT_CHANNELS = ['email', 'push', 'sms', 'whatsapp', 'whatsapp:transactional'] as const;

const updateSchema = z.object({
  channel: z.enum(CONSENT_CHANNELS),
  granted: z.boolean(),
});

@ApiTags('me')
@ApiBearerAuth()
@Controller('me/marketing-consent')
export class MarketingConsentController {
  constructor(private readonly consent: MarketingConsentService) {}

  @Get()
  @ApiOperation({ summary: 'Current marketing-consent state per channel, and its history.' })
  async get(@CurrentUser() user: RequestUser) {
    const subject = { userId: user.id, email: user.email };
    const [channels, history] = await Promise.all([
      this.consent.stateFor(subject, [...CONSENT_CHANNELS]),
      // Returned to the person themselves, not just to an administrator. A data-subject
      // access request asks for exactly this, and the cheapest way to be able to answer one
      // is for the answer to already be an endpoint.
      this.consent.history(subject),
    ]);
    return { channels, history };
  }

  @Put()
  @ApiOperation({ summary: 'Grant or withdraw consent for commercial messages on a channel.' })
  async update(
    @CurrentUser() user: RequestUser,
    @Body(new ZodValidationPipe(updateSchema)) body: z.infer<typeof updateSchema>,
    @Ip() ip: string,
    @Headers('user-agent') userAgent?: string,
  ) {
    /*
      `source` records that the decision came from the account page, in the person's own
      session. That provenance is the point: "checkbox on the settings screen" and
      "imported from a spreadsheet" are both consent rows, and only one of them can be
      defended. It is set here rather than accepted from the client, because a source a
      caller can choose is not evidence of anything.
    */
    await this.consent.record({ userId: user.id, email: user.email }, body.channel, body.granted, {
      /*
        The scope is part of the provenance, not just the channel. "Granted transactional
        WhatsApp on the settings screen" and "granted marketing WhatsApp on the settings
        screen" are two different permissions, and a history that records both as
        `account-settings` on `whatsapp` cannot tell them apart afterwards — which is exactly
        what a regulator or a data-subject request asks it to do.
      */
      source: body.granted
        ? `account-settings:${body.channel}`
        : `withdrawn-by-user:${body.channel}`,
      ipAddress: ip,
      userAgent,
    });
    return this.consent.stateFor({ userId: user.id, email: user.email }, [...CONSENT_CHANNELS]);
  }
}
