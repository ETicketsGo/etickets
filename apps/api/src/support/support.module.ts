import { Module } from '@nestjs/common';
import { NotificationsModule } from '../notifications/notifications.module';
import { AdminSupportController, SupportController } from './support.controller';
import { SupportService } from './support.service';
import { SupportMailService } from './support-mail.service';

@Module({
  // NotificationsModule for the outbox: a form message is mailed by the worker, never inline.
  imports: [NotificationsModule],
  controllers: [SupportController, AdminSupportController],
  providers: [SupportService, SupportMailService],
})
export class SupportModule {}
