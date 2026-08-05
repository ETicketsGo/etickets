import { Body, Controller, Param, Post, RawBodyRequest, Req } from '@nestjs/common';
import type { Request } from 'express';
import { Public } from '../../common/decorators';
import { SyncIngestionService } from './sync-ingestion.service';

/**
 * Provider-neutral inventory webhook ingress (ADR-040 §7). Public (external providers
 * are not JWT clients); every payload is authenticated by the adapter's signature
 * scheme inside the service. The controller only reads the RAW body (needed for
 * signature verification — global rawBody:true) and delegates; it does NO normalization
 * or DB sync, returning a fast provider-appropriate ack. Unknown/disabled providers and
 * invalid signatures fail closed inside the service with safe, generic responses.
 */
@Controller('webhooks/inventory')
export class SyncWebhookController {
  constructor(private readonly ingestion: SyncIngestionService) {}

  @Public()
  @Post(':providerCode')
  async ingest(
    @Param('providerCode') providerCode: string,
    @Req() req: RawBodyRequest<Request>,
    @Body() body: unknown,
  ): Promise<{ received: boolean }> {
    const rawBody = req.rawBody ? req.rawBody.toString('utf8') : JSON.stringify(body ?? {});
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries(req.headers)) {
      headers[k.toLowerCase()] = Array.isArray(v) ? v.join(',') : (v ?? '');
    }
    const correlationId = (req as Request & { correlationId?: string }).correlationId;
    await this.ingestion.ingestWebhook(providerCode, rawBody, headers, correlationId);
    // Ack fast + opaque: never reveal counts/verification detail to the caller.
    return { received: true };
  }
}
