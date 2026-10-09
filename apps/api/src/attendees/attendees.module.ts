import { Module } from '@nestjs/common';
import { AttendeesController } from './attendees.controller';
import { AttendeesService } from './attendees.service';
import { EventAttendeesController } from './event-attendees.controller';
import { EventAttendeesService } from './event-attendees.service';
import { AuditModule } from '../audit/audit.module';
import { NotificationsModule } from '../notifications/notifications.module';

@Module({
  imports: [AuditModule, NotificationsModule],
  controllers: [AttendeesController, EventAttendeesController],
  providers: [AttendeesService, EventAttendeesService],
  exports: [AttendeesService],
})
export class AttendeesModule {}
