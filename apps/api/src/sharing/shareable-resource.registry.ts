import { Injectable } from '@nestjs/common';
import { ResourceType } from '@eticketsgo/shared-types';
import { PrismaService } from '../prisma/prisma.service';
import { QrService } from '../tickets/qr.service';
import type { ShareableResource } from './shareable-resource';
import { TicketShareableResource } from './resources/ticket-shareable.resource';

/**
 * Resolves a (resourceType, id) to a {@link ShareableResource}. Today only TICKET
 * is registered; new wallet items (memberships, passes, vouchers) register a
 * resolver here without touching the sharing engine. See ADR-032.
 */
@Injectable()
export class ShareableResourceRegistry {
  constructor(
    private readonly prisma: PrismaService,
    private readonly qr: QrService,
  ) {}

  async resolve(resourceType: string, id: string): Promise<ShareableResource | null> {
    switch (resourceType) {
      case ResourceType.TICKET:
        return this.resolveTicket(id);
      default:
        return null;
    }
  }

  private async resolveTicket(id: string): Promise<ShareableResource | null> {
    const row = await this.prisma.ticket.findUnique({
      where: { id },
      select: {
        id: true,
        organizationId: true,
        status: true,
        nonce: true,
        qrVersion: true,
        eventSessionId: true,
        serial: true,
        seatLabel: true,
        holderName: true,
        booking: { select: { userId: true, reference: true } },
        ticketType: { select: { name: true } },
        eventSession: {
          select: {
            startsAt: true,
            endsAt: true,
            screen: { select: { name: true, cinema: { select: { name: true } } } },
            event: {
              select: {
                title: true,
                experienceType: true,
                venue: { select: { name: true } },
              },
            },
          },
        },
      },
    });
    return row ? new TicketShareableResource(row, this.qr) : null;
  }
}
