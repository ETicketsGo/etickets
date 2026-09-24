import { Module } from '@nestjs/common';
import {
  AdminOrganizationsController,
  OrganizationsController,
  PublicInvitationsController,
  PublicOrganizerLogoController,
} from './organizations.controller';
import { OrganizationsService } from './organizations.service';
import { OrganizationImagesService } from './organization-images.service';
import { OrganizationLifecycleService } from './organization-lifecycle.service';

@Module({
  controllers: [
    OrganizationsController,
    AdminOrganizationsController,
    PublicInvitationsController,
    PublicOrganizerLogoController,
  ],
  providers: [OrganizationsService, OrganizationImagesService, OrganizationLifecycleService],
  exports: [OrganizationsService, OrganizationImagesService, OrganizationLifecycleService],
})
export class OrganizationsModule {}
