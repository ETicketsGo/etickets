import { Module } from '@nestjs/common';
import {
  AdminOrganizationsController,
  OrganizationsController,
  PublicInvitationsController,
} from './organizations.controller';
import { OrganizationsService } from './organizations.service';

@Module({
  controllers: [OrganizationsController, AdminOrganizationsController, PublicInvitationsController],
  providers: [OrganizationsService],
  exports: [OrganizationsService],
})
export class OrganizationsModule {}
