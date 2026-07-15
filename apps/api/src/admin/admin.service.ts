import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

function paginate(page: number, pageSize: number, total: number) {
  return { page, pageSize, total, totalPages: Math.ceil(total / pageSize) };
}

@Injectable()
export class AdminService {
  constructor(private readonly prisma: PrismaService) {}

  async bookings(params: { page: number; pageSize: number; status?: string; q?: string }) {
    const where = {
      ...(params.status ? { status: params.status as never } : {}),
      ...(params.q
        ? {
            OR: [
              { buyerEmail: { contains: params.q, mode: 'insensitive' as const } },
              { reference: { contains: params.q, mode: 'insensitive' as const } },
            ],
          }
        : {}),
    };
    const [total, rows] = await this.prisma.$transaction([
      this.prisma.booking.count({ where }),
      this.prisma.booking.findMany({
        where,
        skip: (params.page - 1) * params.pageSize,
        take: params.pageSize,
        orderBy: { createdAt: 'desc' },
        include: { event: { select: { title: true } }, payment: { select: { status: true } } },
      }),
    ]);
    return {
      data: rows.map((b) => ({
        id: b.id,
        reference: b.reference,
        status: b.status,
        buyerEmail: b.buyerEmail,
        totalMinor: b.totalMinor,
        createdAt: b.createdAt,
        event: { title: b.event.title },
        paymentStatus: b.payment?.status ?? null,
      })),
      meta: paginate(params.page, params.pageSize, total),
    };
  }

  async payments(params: { page: number; pageSize: number; status?: string }) {
    const where = params.status ? { status: params.status as never } : {};
    const [total, rows] = await this.prisma.$transaction([
      this.prisma.payment.count({ where }),
      this.prisma.payment.findMany({
        where,
        skip: (params.page - 1) * params.pageSize,
        take: params.pageSize,
        orderBy: { createdAt: 'desc' },
        include: { booking: { select: { buyerEmail: true } } },
      }),
    ]);
    return {
      data: rows.map((p) => ({
        id: p.id,
        status: p.status,
        amountMinor: p.amountMinor,
        provider: p.provider,
        providerRef: p.providerRef,
        createdAt: p.createdAt,
        bookingId: p.bookingId,
        buyerEmail: p.booking.buyerEmail,
      })),
      meta: paginate(params.page, params.pageSize, total),
    };
  }

  feeRules() {
    return this.prisma.feeRule.findMany({ orderBy: { minMinor: 'asc' } });
  }
}
