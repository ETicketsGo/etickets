import { Module } from '@nestjs/common';
import { SharingController } from './sharing.controller';
import { SharingService } from './sharing.service';
import { ShareableResourceRegistry } from './shareable-resource.registry';
import { AuditModule } from '../audit/audit.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { TicketsModule } from '../tickets/tickets.module';

@Module({
  // TicketsModule exports QrService (for the ticket resource adapter + guest QR).
  imports: [AuditModule, NotificationsModule, TicketsModule],
  controllers: [SharingController],
  providers: [SharingService, ShareableResourceRegistry],
  exports: [SharingService],
})
export class SharingModule {}
