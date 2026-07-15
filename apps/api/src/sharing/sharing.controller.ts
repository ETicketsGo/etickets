import { Body, Controller, Get, Param, Post } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { ResourceType, type SharePermission } from '@eticketsgo/shared-types';
import {
  changeSharePermissionSchema,
  createShareSchema,
  extendShareSchema,
  type ChangeSharePermissionInput,
  type CreateShareInput,
  type ExtendShareInput,
} from '@eticketsgo/validation';
import { SharingService } from './sharing.service';
import { CurrentUser, Public, type RequestUser } from '../common/decorators';
import { ZodValidationPipe } from '../common/zod-validation.pipe';

@ApiTags('sharing')
@ApiBearerAuth()
@Controller()
export class SharingController {
  constructor(private readonly sharing: SharingService) {}

  // ── owner ──────────────────────────────────────────────────────────
  @Post('tickets/:id/share')
  @ApiOperation({ summary: 'Create a secure share link for a ticket (owner).' })
  create(
    @CurrentUser() user: RequestUser,
    @Param('id') id: string,
    @Body(new ZodValidationPipe(createShareSchema)) body: CreateShareInput,
  ) {
    return this.sharing.createShare(user, ResourceType.TICKET, id, body);
  }

  @Get('tickets/:id/shares')
  @ApiOperation({ summary: 'List share links + activity for a ticket (owner).' })
  activity(@CurrentUser() user: RequestUser, @Param('id') id: string) {
    return this.sharing.activityForTicket(user, id);
  }

  @Post('shares/:id/revoke')
  @ApiOperation({ summary: 'Revoke a share link (owner).' })
  revoke(@CurrentUser() user: RequestUser, @Param('id') id: string) {
    return this.sharing.revoke(user, id);
  }

  @Post('shares/:id/extend')
  @ApiOperation({ summary: 'Extend a share link’s expiry (owner).' })
  extend(
    @CurrentUser() user: RequestUser,
    @Param('id') id: string,
    @Body(new ZodValidationPipe(extendShareSchema)) body: ExtendShareInput,
  ) {
    return this.sharing.extend(user, id, body);
  }

  @Post('shares/:id/permission')
  @ApiOperation({ summary: 'Change a share link’s permission (owner).' })
  permission(
    @CurrentUser() user: RequestUser,
    @Param('id') id: string,
    @Body(new ZodValidationPipe(changeSharePermissionSchema)) body: ChangeSharePermissionInput,
  ) {
    return this.sharing.changePermission(user, id, body.permission as SharePermission);
  }

  // ── recipient (public; link-based, no login required) ───────────────
  @Public()
  @Post('public/share/:token')
  @ApiOperation({ summary: 'Resolve a share link; returns a permission-scoped view.' })
  resolve(@Param('token') token: string) {
    return this.sharing.resolveShare(token, {});
  }
}
