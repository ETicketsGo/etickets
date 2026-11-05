import { Module } from '@nestjs/common';
// EmailVerificationService: an invitation is accepted only once the invitee's email is proved.
import { AuthModule } from '../auth/auth.module';
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
  imports: [AuthModule],
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
