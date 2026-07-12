import { Body, Controller, Get, Patch, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { z } from 'zod';
import { Role } from '@eticketsgo/shared-types';
import { paginationSchema } from '@eticketsgo/validation';
import { UsersService } from './users.service';
import { CurrentUser, Roles } from '../common/decorators';
import { ZodValidationPipe } from '../common/zod-validation.pipe';

const updateProfileSchema = z.object({ fullName: z.string().trim().min(2).max(120) });

@ApiTags('users')
@ApiBearerAuth()
@Controller('users')
export class UsersController {
  constructor(private readonly users: UsersService) {}

  @Get('me')
  @ApiOperation({ summary: 'Get the current user profile.' })
  me(@CurrentUser('id') userId: string) {
    return this.users.profile(userId);
  }

  @Patch('me')
  @ApiOperation({ summary: 'Update the current user profile.' })
  updateMe(
    @CurrentUser('id') userId: string,
    @Body(new ZodValidationPipe(updateProfileSchema)) body: { fullName: string },
  ) {
    return this.users.updateProfile(userId, body.fullName);
  }

  @Get()
  @Roles(Role.ADMIN, Role.SUPER_ADMIN)
  @ApiOperation({ summary: 'List users (admin).' })
  list(
    @Query(new ZodValidationPipe(paginationSchema.extend({ q: z.string().optional() })))
    q: {
      page: number;
      pageSize: number;
      q?: string;
    },
  ) {
    return this.users.list(q.page, q.pageSize, q.q);
  }
}
