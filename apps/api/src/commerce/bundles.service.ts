import { HttpStatus, Injectable } from '@nestjs/common';
import { Role, priceBundle, type BundleComponentInput } from '@eticketsgo/shared-types';
import type { CreateBundleInput, UpdateBundleInput } from '@eticketsgo/validation';
import { PrismaService } from '../prisma/prisma.service';
import { OrgAccessService } from '../tenancy/org-access.service';
import { AuditService } from '../audit/audit.service';
import { AppException, ErrorCodes } from '../common/errors';
import type { RequestUser } from '../common/decorators';
import { onSale } from './addons.service';

const ORGANIZER_ROLES = [Role.ORGANIZER_OWNER, Role.ORGANIZER_MANAGER];

type ComponentInput = { ticketTypeId?: string; addOnId?: string; quantity: number };

/**
 * Organizer bundle catalog (v1.3 WS3) + the public priced-preview read. A bundle is
 * a pre-priced package of ticket types and/or add-ons; the checkout expands it into
 * component lines (see BookingsService). Pricing math is the pure `priceBundle`.
 */
@Injectable()
export class BundlesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly access: OrgAccessService,
    private readonly audit: AuditService,
  ) {}

  private async assertEventAccess(user: RequestUser, eventId: string) {
    const event = await this.prisma.event.findUnique({ where: { id: eventId } });
    if (!event)
      throw new AppException(ErrorCodes.NOT_FOUND, 'Event not found.', HttpStatus.NOT_FOUND);
    await this.access.assertMember(user, event.organizationId, ORGANIZER_ROLES);
    return event;
  }

  private async loadOwnedBundle(user: RequestUser, bundleId: string) {
    const bundle = await this.prisma.bundle.findUnique({
      where: { id: bundleId },
      include: { event: true, items: true },
    });
    if (!bundle)
      throw new AppException(ErrorCodes.NOT_FOUND, 'Bundle not found.', HttpStatus.NOT_FOUND);
    await this.access.assertMember(user, bundle.event.organizationId, ORGANIZER_ROLES);
    return bundle;
  }

  /** Validate that every component ticket type / add-on belongs to this event. */
  private async assertComponentsBelong(eventId: string, items: ComponentInput[]) {
    const ticketTypeIds = items.map((i) => i.ticketTypeId).filter(Boolean) as string[];
    const addOnIds = items.map((i) => i.addOnId).filter(Boolean) as string[];
    if (ticketTypeIds.length) {
      const found = await this.prisma.ticketType.count({
        where: { id: { in: ticketTypeIds }, eventSession: { eventId } },
      });
      if (found !== new Set(ticketTypeIds).size)
        throw new AppException(
          ErrorCodes.VALIDATION_FAILED,
          'A bundle ticket type does not belong to this event.',
          HttpStatus.BAD_REQUEST,
        );
    }
    if (addOnIds.length) {
      const found = await this.prisma.addOn.count({
        where: { id: { in: addOnIds }, eventId },
      });
      if (found !== new Set(addOnIds).size)
        throw new AppException(
          ErrorCodes.VALIDATION_FAILED,
          'A bundle add-on does not belong to this event.',
          HttpStatus.BAD_REQUEST,
        );
    }
  }

  async listForEvent(user: RequestUser, eventId: string) {
    await this.assertEventAccess(user, eventId);
    const bundles = await this.prisma.bundle.findMany({
      where: { eventId },
      orderBy: { createdAt: 'asc' },
      include: { items: true },
    });
    return Promise.all(bundles.map((b) => this.withPricing(b)));
  }

  async create(user: RequestUser, eventId: string, input: CreateBundleInput) {
    await this.assertEventAccess(user, eventId);
    await this.assertComponentsBelong(eventId, input.items);
    const bundle = await this.prisma.bundle.create({
      data: {
        eventId,
        type: input.type,
        name: input.name,
        description: input.description,
        pricingKind: input.pricingKind,
        priceMinor: input.pricingKind === 'FIXED' ? (input.priceMinor ?? 0) : null,
        discountPercent:
          input.pricingKind === 'PERCENT_DISCOUNT' ? (input.discountPercent ?? 0) : null,
        maxPerOrder: input.maxPerOrder,
        salesStartAt: input.salesStartAt ?? null,
        salesEndAt: input.salesEndAt ?? null,
        enabled: input.enabled,
        items: {
          create: input.items.map((i) => ({
            ticketTypeId: i.ticketTypeId ?? null,
            addOnId: i.addOnId ?? null,
            quantity: i.quantity,
          })),
        },
      },
      include: { items: true },
    });
    await this.audit.record({
      actorUserId: user.id,
      organizationId: (await this.prisma.event.findUnique({ where: { id: eventId } }))!
        .organizationId,
      action: 'BUNDLE_CREATED',
      entityType: 'Bundle',
      entityId: bundle.id,
      metadata: { type: bundle.type },
    });
    return this.withPricing(bundle);
  }

  async update(user: RequestUser, bundleId: string, input: UpdateBundleInput) {
    const existing = await this.loadOwnedBundle(user, bundleId);
    if (input.items) await this.assertComponentsBelong(existing.eventId, input.items);

    const nextKind = input.pricingKind ?? existing.pricingKind;
    const bundle = await this.prisma.bundle.update({
      where: { id: bundleId },
      data: {
        name: input.name,
        description: input.description === null ? null : input.description,
        pricingKind: input.pricingKind,
        priceMinor: nextKind === 'FIXED' ? (input.priceMinor ?? existing.priceMinor ?? 0) : null,
        discountPercent:
          nextKind === 'PERCENT_DISCOUNT'
            ? (input.discountPercent ?? existing.discountPercent ?? 0)
            : null,
        maxPerOrder: input.maxPerOrder,
        salesStartAt: input.salesStartAt,
        salesEndAt: input.salesEndAt,
        enabled: input.enabled,
        ...(input.items
          ? {
              items: {
                deleteMany: {},
                create: input.items.map((i) => ({
                  ticketTypeId: i.ticketTypeId ?? null,
                  addOnId: i.addOnId ?? null,
                  quantity: i.quantity,
                })),
              },
            }
          : {}),
      },
      include: { items: true },
    });
    await this.audit.record({
      actorUserId: user.id,
      organizationId: existing.event.organizationId,
      action: 'BUNDLE_UPDATED',
      entityType: 'Bundle',
      entityId: bundle.id,
    });
    return this.withPricing(bundle);
  }

  /** Delete a bundle that has never sold; otherwise disable it (fail closed). */
  async remove(user: RequestUser, bundleId: string) {
    const existing = await this.loadOwnedBundle(user, bundleId);
    const sold = await this.prisma.bookingItem.count({ where: { bundleId } });
    if (sold > 0) {
      throw new AppException(
        ErrorCodes.CONFLICT,
        'This bundle has sales and cannot be deleted. Disable it instead.',
        HttpStatus.CONFLICT,
      );
    }
    await this.prisma.bundle.delete({ where: { id: bundleId } });
    await this.audit.record({
      actorUserId: user.id,
      organizationId: existing.event.organizationId,
      action: 'BUNDLE_DELETED',
      entityType: 'Bundle',
      entityId: bundleId,
    });
    return { deleted: true };
  }

  async publicListForEvent(eventId: string, now = new Date()) {
    const bundles = await this.prisma.bundle.findMany({
      where: { eventId, enabled: true },
      orderBy: { createdAt: 'asc' },
      include: { items: true },
    });
    const priced = await Promise.all(
      bundles
        .filter((b) => onSale(b.salesStartAt, b.salesEndAt, now))
        .map((b) => this.withPricing(b)),
    );
    // A bundle whose components were removed / mispriced returns no components — hide it.
    return priced.filter((b) => b.components.length > 0);
  }

  /** Attach a priced preview (one-bundle pricing + component labels) to a bundle row. */
  private async withPricing(bundle: {
    id: string;
    type: string;
    name: string;
    description: string | null;
    currency: string;
    pricingKind: string;
    priceMinor: number | null;
    discountPercent: number | null;
    maxPerOrder: number;
    enabled: boolean;
    eventId: string;
    items: { ticketTypeId: string | null; addOnId: string | null; quantity: number }[];
  }) {
    const ticketTypeIds = bundle.items.map((i) => i.ticketTypeId).filter(Boolean) as string[];
    const addOnIds = bundle.items.map((i) => i.addOnId).filter(Boolean) as string[];
    const [tts, addOns] = await Promise.all([
      ticketTypeIds.length
        ? this.prisma.ticketType.findMany({
            where: { id: { in: ticketTypeIds } },
            select: { id: true, name: true, priceMinor: true },
          })
        : Promise.resolve([]),
      addOnIds.length
        ? this.prisma.addOn.findMany({
            where: { id: { in: addOnIds } },
            select: { id: true, name: true, priceMinor: true },
          })
        : Promise.resolve([]),
    ]);
    const ttById = new Map(tts.map((t) => [t.id, t]));
    const addOnById = new Map(addOns.map((a) => [a.id, a]));

    const components = bundle.items
      .map((i) => {
        if (i.ticketTypeId) {
          const t = ttById.get(i.ticketTypeId);
          if (!t) return null;
          return {
            refId: t.id,
            isTicket: true,
            label: t.name,
            listUnitPriceMinor: t.priceMinor,
            quantity: i.quantity,
          };
        }
        const a = addOnById.get(i.addOnId!);
        if (!a) return null;
        return {
          refId: a.id,
          isTicket: false,
          label: a.name,
          listUnitPriceMinor: a.priceMinor,
          quantity: i.quantity,
        };
      })
      .filter(Boolean) as (BundleComponentInput & { label: string })[];

    const pricing =
      components.length > 0
        ? priceBundle({
            pricingKind: bundle.pricingKind as 'FIXED' | 'PERCENT_DISCOUNT',
            fixedPriceMinor: bundle.priceMinor,
            discountPercent: bundle.discountPercent,
            components,
            bundleQuantity: 1,
          })
        : {
            bundleUnitPriceMinor: 0,
            totalMinor: 0,
            listTotalMinor: 0,
            savingsMinor: 0,
            components: [],
          };

    return {
      id: bundle.id,
      type: bundle.type,
      name: bundle.name,
      description: bundle.description,
      currency: bundle.currency,
      pricingKind: bundle.pricingKind,
      priceMinor: bundle.priceMinor,
      discountPercent: bundle.discountPercent,
      maxPerOrder: bundle.maxPerOrder,
      enabled: bundle.enabled,
      priceFromMinor: pricing.bundleUnitPriceMinor,
      listTotalMinor: pricing.listTotalMinor,
      savingsMinor: pricing.savingsMinor,
      components: components.map((c) => ({
        refId: c.refId,
        isTicket: c.isTicket,
        label: c.label,
        quantity: c.quantity,
        listUnitPriceMinor: c.listUnitPriceMinor,
      })),
    };
  }
}
