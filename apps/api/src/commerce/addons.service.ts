import { HttpStatus, Injectable } from '@nestjs/common';
import { Role } from '@eticketsgo/shared-types';
import type { CreateAddOnInput, UpdateAddOnInput } from '@eticketsgo/validation';
import { PrismaService } from '../prisma/prisma.service';
import { OrgAccessService } from '../tenancy/org-access.service';
import { AuditService } from '../audit/audit.service';
import { AppException, ErrorCodes } from '../common/errors';
import type { RequestUser } from '../common/decorators';

const ORGANIZER_ROLES = [Role.ORGANIZER_OWNER, Role.ORGANIZER_MANAGER];

/**
 * Organizer add-on catalog (v1.3 WS1/WS4) + the public availability read used by
 * the event page and checkout. Add-ons are event-scoped; every write asserts org
 * membership and is audited. Stock lives in AddOnInventory (see AddOnInventoryService);
 * `quantityTotal === null` means unlimited (donations / digital goods).
 */
@Injectable()
export class AddOnsService {
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

  private async loadOwnedAddOn(user: RequestUser, addOnId: string) {
    const addOn = await this.prisma.addOn.findUnique({
      where: { id: addOnId },
      include: { event: true, inventory: true },
    });
    if (!addOn)
      throw new AppException(ErrorCodes.NOT_FOUND, 'Add-on not found.', HttpStatus.NOT_FOUND);
    await this.access.assertMember(user, addOn.event.organizationId, ORGANIZER_ROLES);
    return addOn;
  }

  /** Organizer view: every add-on for an event with its stock counters. */
  async listForEvent(user: RequestUser, eventId: string) {
    await this.assertEventAccess(user, eventId);
    return this.prisma.addOn.findMany({
      where: { eventId },
      orderBy: { createdAt: 'asc' },
      include: { inventory: true },
    });
  }

  async create(user: RequestUser, eventId: string, input: CreateAddOnInput) {
    await this.assertEventAccess(user, eventId);
    const addOn = await this.prisma.addOn.create({
      data: {
        eventId,
        type: input.type,
        name: input.name,
        description: input.description,
        priceMinor: input.priceMinor,
        imageUrl: input.imageUrl || null,
        maxPerOrder: input.maxPerOrder,
        salesStartAt: input.salesStartAt ?? null,
        salesEndAt: input.salesEndAt ?? null,
        enabled: input.enabled,
        inventory: { create: { quantityTotal: input.quantityTotal ?? null } },
      },
      include: { inventory: true },
    });
    await this.audit.record({
      actorUserId: user.id,
      organizationId: (await this.prisma.event.findUnique({ where: { id: eventId } }))!
        .organizationId,
      action: 'ADDON_CREATED',
      entityType: 'AddOn',
      entityId: addOn.id,
      metadata: { type: addOn.type },
    });
    return addOn;
  }

  async update(user: RequestUser, addOnId: string, input: UpdateAddOnInput) {
    const existing = await this.loadOwnedAddOn(user, addOnId);
    const sold = existing.inventory?.quantitySold ?? 0;

    // Guard stock: never set a total below what's already sold+held.
    if (input.quantityTotal !== undefined && input.quantityTotal !== null) {
      const held = existing.inventory?.quantityHeld ?? 0;
      if (input.quantityTotal < sold + held) {
        throw new AppException(
          ErrorCodes.VALIDATION_FAILED,
          `Stock can't be below the ${sold + held} already sold or held.`,
          HttpStatus.BAD_REQUEST,
        );
      }
    }

    const addOn = await this.prisma.addOn.update({
      where: { id: addOnId },
      data: {
        name: input.name,
        description: input.description === null ? null : input.description,
        priceMinor: input.priceMinor,
        imageUrl: input.imageUrl === undefined ? undefined : input.imageUrl || null,
        maxPerOrder: input.maxPerOrder,
        salesStartAt: input.salesStartAt,
        salesEndAt: input.salesEndAt,
        enabled: input.enabled,
        ...(input.quantityTotal !== undefined
          ? { inventory: { update: { quantityTotal: input.quantityTotal } } }
          : {}),
      },
      include: { inventory: true },
    });
    await this.audit.record({
      actorUserId: user.id,
      organizationId: existing.event.organizationId,
      action: 'ADDON_UPDATED',
      entityType: 'AddOn',
      entityId: addOn.id,
    });
    return addOn;
  }

  /** Delete an unsold add-on; if it has ever sold, disable it instead (fail closed). */
  async remove(user: RequestUser, addOnId: string) {
    const existing = await this.loadOwnedAddOn(user, addOnId);
    const sold = existing.inventory?.quantitySold ?? 0;
    const held = existing.inventory?.quantityHeld ?? 0;
    if (sold > 0 || held > 0) {
      throw new AppException(
        ErrorCodes.CONFLICT,
        'This add-on has sales and cannot be deleted. Disable it instead.',
        HttpStatus.CONFLICT,
      );
    }
    await this.prisma.addOn.delete({ where: { id: addOnId } });
    await this.audit.record({
      actorUserId: user.id,
      organizationId: existing.event.organizationId,
      action: 'ADDON_DELETED',
      entityType: 'AddOn',
      entityId: addOnId,
    });
    return { deleted: true };
  }

  /** Public: add-ons a buyer can currently purchase for an event, with remaining stock. */
  async publicListForEvent(eventId: string, now = new Date()) {
    const rows = await this.prisma.addOn.findMany({
      where: { eventId, enabled: true },
      orderBy: { priceMinor: 'asc' },
      include: { inventory: true },
    });
    return rows
      .filter((a) => onSale(a.salesStartAt, a.salesEndAt, now))
      .map((a) => toPublicAddOn(a));
  }
}

export function onSale(start: Date | null, end: Date | null, now: Date): boolean {
  if (start && now < start) return false;
  if (end && now > end) return false;
  return true;
}

export function toPublicAddOn(a: {
  id: string;
  type: string;
  name: string;
  description: string | null;
  priceMinor: number;
  currency: string;
  imageUrl: string | null;
  maxPerOrder: number;
  inventory: { quantityTotal: number | null; quantitySold: number; quantityHeld: number } | null;
}) {
  const inv = a.inventory;
  const remaining =
    inv && inv.quantityTotal !== null
      ? Math.max(0, inv.quantityTotal - inv.quantitySold - inv.quantityHeld)
      : null; // null = unlimited
  return {
    id: a.id,
    type: a.type,
    name: a.name,
    description: a.description,
    priceMinor: a.priceMinor,
    currency: a.currency,
    imageUrl: a.imageUrl,
    maxPerOrder: a.maxPerOrder,
    remaining,
    soldOut: remaining !== null && remaining <= 0,
  };
}
