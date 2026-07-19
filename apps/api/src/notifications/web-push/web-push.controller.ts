import { Body, Controller, Get, Post } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { z } from 'zod';
import { WebPushService } from './web-push.service';
import { CurrentUser, type RequestUser } from '../../common/decorators';
import { ZodValidationPipe } from '../../common/zod-validation.pipe';

const subscribeSchema = z.object({
  endpoint: z.string().url().max(1000),
  keys: z.object({ p256dh: z.string().min(1).max(500), auth: z.string().min(1).max(500) }),
  userAgent: z.string().max(500).optional(),
});
const unsubscribeSchema = z.object({ endpoint: z.string().url().max(1000) });

@ApiTags('push')
@ApiBearerAuth()
@Controller('push')
export class WebPushController {
  constructor(private readonly webPush: WebPushService) {}

  @Get('vapid-public-key')
  @ApiOperation({ summary: 'The public VAPID key browsers use to subscribe (null if unset).' })
  vapidKey() {
    return { publicKey: this.webPush.vapidPublicKey() };
  }

  @Post('subscribe')
  @ApiOperation({ summary: 'Register a browser Web Push subscription.' })
  subscribe(
    @CurrentUser() user: RequestUser,
    @Body(new ZodValidationPipe(subscribeSchema))
    body: { endpoint: string; keys: { p256dh: string; auth: string }; userAgent?: string },
  ) {
    return this.webPush.subscribe(user.id, body);
  }

  @Post('unsubscribe')
  @ApiOperation({ summary: 'Remove a browser Web Push subscription.' })
  unsubscribe(
    @CurrentUser() user: RequestUser,
    @Body(new ZodValidationPipe(unsubscribeSchema)) body: { endpoint: string },
  ) {
    return this.webPush.unsubscribe(user.id, body.endpoint);
  }
}
