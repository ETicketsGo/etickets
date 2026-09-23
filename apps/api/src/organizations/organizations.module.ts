import { Module } from '@nestjs/common';
import {
  AdminOrganizationsController,
  OrganizationsController,
  PublicInvitationsController,
  PublicOrganizerLogoController,
} from './organizations.controller';
import { OrganizationsService } from './organizations.service';
import { OrganizationLogoService } from './organization-logo.service';

@Module({
  controllers: [
    OrganizationsController,
    AdminOrganizationsController,
    PublicInvitationsController,
    PublicOrganizerLogoController,
  ],
  providers: [OrganizationsService, OrganizationLogoService],
  exports: [OrganizationsService, OrganizationLogoService],
})
export class OrganizationsModule {}
