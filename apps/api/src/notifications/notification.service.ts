import { Injectable, Logger } from '@nestjs/common';
import { NotificationType } from '@eticketsgo/shared-types';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';

export interface NotifyInput {
  type: NotificationType;
  userId?: string | null;
  toEmail?: string | null;
  payload: Record<string, unknown>;
}

/**
 * Notification abstraction. MVP persists notifications and logs the email body
 * locally; SendGrid/Twilio/WhatsApp providers plug in behind sendEmail().
 */
@Injectable()
export class NotificationService {
  private readonly logger = new Logger('Notification');

  constructor(private readonly prisma: PrismaService) {}

  async send(input: NotifyInput): Promise<void> {
    const notification = await this.prisma.notification.create({
      data: {
        type: input.type,
        userId: input.userId ?? null,
        toEmail: input.toEmail ?? null,
        payload: input.payload as Prisma.InputJsonValue,
        status: 'SENT',
        sentAt: new Date(),
      },
    });
    this.logger.log(
      `[email:${input.type}] -> ${input.toEmail ?? 'n/a'} :: ${JSON.stringify(input.payload)} (id ${notification.id})`,
    );
  }
}
