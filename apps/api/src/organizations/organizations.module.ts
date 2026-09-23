import { Module } from '@nestjs/common';
import {
  AdminOrganizationsController,
  OrganizationsController,
  PublicInvitationsController,
  PublicOrganizerLogoController,
} from './organizations.controller';
import { OrganizationsService } from './organizations.service';
import { OrganizationImagesService } from './organization-images.service';

@Module({
  controllers: [
    OrganizationsController,
    AdminOrganizationsController,
    PublicInvitationsController,
    PublicOrganizerLogoController,
  ],
  providers: [OrganizationsService, OrganizationImagesService],
  exports: [OrganizationsService, OrganizationImagesService],
})
export class OrganizationsModule {}
