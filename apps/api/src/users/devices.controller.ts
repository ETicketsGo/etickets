import { Body, Controller, Delete, Get, Param, Patch, Post } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { z } from 'zod';
import { DevicesService } from './devices.service';
import { CurrentUser } from '../common/decorators';
import { ZodValidationPipe } from '../common/zod-validation.pipe';

/**
 * Push tokens are opaque and provider-specific, so the only sane validation is a length
 * bound and a character-class that rules out control characters and whitespace — a
 * stricter pattern would reject a future provider's format for no security gain.
 */
const tokenSchema = z
  .string()
  .trim()
  .min(16)
  .max(512)
  .regex(/^[\x21-\x7E]+$/, 'token must be printable ASCII with no spaces');

const platformSchema = z.enum(['android', 'ios']);
const permissionSchema = z.enum(['granted', 'denied', 'undetermined']);

const registerDeviceSchema = z.object({
  token: tokenSchema,
  provider: z.enum(['expo', 'fcm', 'apns']).optional(),
  platform: platformSchema,
  appVersion: z.string().trim().max(32).optional(),
  locale: z.string().trim().max(35).optional(),
  timezone: z.string().trim().max(64).optional(),
  permissionStatus: permissionSchema.optional(),
});

/**
 * The token is deliberately NOT patchable: a new token is a new registration. Letting a
 * PATCH rewrite it would move a device row onto an arbitrary token without the client
 * ever proving it holds that token.
 */
const updateDeviceSchema = z.object({
  appVersion: z.string().trim().max(32).optional(),
  locale: z.string().trim().max(35).optional(),
  timezone: z.string().trim().max(64).optional(),
  permissionStatus: permissionSchema.optional(),
  disabled: z.boolean().optional(),
});

@ApiTags('users')
@ApiBearerAuth()
@Controller('users/me/devices')
export class DevicesController {
  constructor(private readonly devices: DevicesService) {}

  @Get()
  @ApiOperation({
    summary: "List the caller's registered push devices.",
    description:
      'Scoped to the caller with no widening parameter, so it cannot be used to ' +
      'enumerate devices. Tokens are returned masked to their last six characters.',
  })
  list(@CurrentUser('id') userId: string) {
    return this.devices.listMine(userId);
  }

  @Post()
  @ApiOperation({
    summary: 'Register or refresh a push device.',
    description:
      'Idempotent and keyed on the token: re-registering the same device updates one ' +
      'row, and a token that appears under a different account is REASSIGNED to it — ' +
      'otherwise a shared or resold phone would keep receiving the previous account’s ' +
      'notifications.',
  })
  @ApiResponse({ status: 201, description: 'Device registered. Token is masked in the response.' })
  register(
    @CurrentUser('id') userId: string,
    @Body(new ZodValidationPipe(registerDeviceSchema))
    body: z.infer<typeof registerDeviceSchema>,
  ) {
    return this.devices.register(userId, body);
  }

  @Patch(':deviceId')
  @ApiOperation({ summary: 'Update a device the caller owns. The token cannot be changed.' })
  @ApiResponse({ status: 404, description: 'Unknown device, or one belonging to another user.' })
  update(
    @CurrentUser('id') userId: string,
    @Param('deviceId') deviceId: string,
    @Body(new ZodValidationPipe(updateDeviceSchema)) body: z.infer<typeof updateDeviceSchema>,
  ) {
    return this.devices.update(userId, deviceId, body);
  }

  @Delete(':deviceId')
  @ApiOperation({
    summary: 'Deregister a device (called on logout).',
    description: 'Idempotent — removing a device that is already gone reports success.',
  })
  remove(@CurrentUser('id') userId: string, @Param('deviceId') deviceId: string) {
    return this.devices.remove(userId, deviceId);
  }
}
