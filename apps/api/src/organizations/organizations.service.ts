import { HttpStatus, Injectable } from '@nestjs/common';
import { randomBytes } from 'node:crypto';
import * as bcrypt from 'bcryptjs';
import { OrganizationStatus, Role } from '@eticketsgo/shared-types';
import type {
  CreateOrganizationInput,
  InviteMemberInput,
  ReviewDecisionInput,
} from '@eticketsgo/validation';
import { PrismaService } from '../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import { OrgAccessService } from '../tenancy/org-access.service';
import { AppException, ErrorCodes } from '../common/errors';
import type { RequestUser } from '../common/decorators';

function slugify(name: string): string {
  return `${name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/(^-|-$)/g, '')}-${randomBytes(3).toString('hex')}`;
}

@Injectable()
export class OrganizationsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly access: OrgAccessService,
    private readonly audit: AuditService,
  ) {}

  async register(user: RequestUser, input: CreateOrganizationInput) {
    const org = await this.prisma.organization.create({
      data: {
        name: input.name,
        slug: slugify(input.name),
        contactEmail: input.contactEmail,
        status: OrganizationStatus.PENDING,
        members: { create: { userId: user.id, role: Role.ORGANIZER_OWNER } },
      },
    });

    // Grant the platform organizer role if the user does not have it yet.
    if (!user.roles.includes(Role.ORGANIZER_OWNER)) {
      await this.prisma.user.update({
        where: { id: user.id },
        data: { roles: { set: [...new Set([...user.roles, Role.ORGANIZER_OWNER])] } },
      });
    }

    await this.audit.record({
      actorUserId: user.id,
      organizationId: org.id,
      action: 'ORGANIZATION_CREATED',
      entityType: 'Organization',
      entityId: org.id,
    });
    return org;
  }

  async listMine(user: RequestUser) {
    const ids = await this.access.managedOrganizationIds(user);
    return this.prisma.organization.findMany({
      where: ids ? { id: { in: ids } } : {},
      orderBy: { createdAt: 'desc' },
      include: { _count: { select: { members: true, events: true, venues: true } } },
    });
  }

  async get(user: RequestUser, id: string) {
    await this.access.assertMember(user, id);
    const org = await this.prisma.organization.findUnique({
      where: { id },
      include: { _count: { select: { members: true, events: true, venues: true } } },
    });
    if (!org)
      throw new AppException(ErrorCodes.NOT_FOUND, 'Organization not found.', HttpStatus.NOT_FOUND);
    return org;
  }

  async listMembers(user: RequestUser, orgId: string) {
    await this.access.assertMember(user, orgId, [Role.ORGANIZER_OWNER, Role.ORGANIZER_MANAGER]);
    return this.prisma.organizationMember.findMany({
      where: { organizationId: orgId },
      include: { user: { select: { id: true, email: true, fullName: true } } },
      orderBy: { createdAt: 'asc' },
    });
  }

  async inviteMember(user: RequestUser, orgId: string, input: InviteMemberInput) {
    await this.access.assertMember(user, orgId, [Role.ORGANIZER_OWNER]);

    let invitee = await this.prisma.user.findUnique({ where: { email: input.email } });
    if (!invitee) {
      const passwordHash = await bcrypt.hash(randomBytes(16).toString('hex'), 10);
      invitee = await this.prisma.user.create({
        data: {
          email: input.email,
          fullName: input.email.split('@')[0],
          passwordHash,
          roles: [Role.CUSTOMER],
        },
      });
    }

    const existing = await this.prisma.organizationMember.findUnique({
      where: { organizationId_userId: { organizationId: orgId, userId: invitee.id } },
    });
    if (existing) {
      throw new AppException(
        ErrorCodes.CONFLICT,
        'This person is already a team member.',
        HttpStatus.CONFLICT,
      );
    }

    const member = await this.prisma.organizationMember.create({
      data: { organizationId: orgId, userId: invitee.id, role: input.role, status: 'INVITED' },
      include: { user: { select: { id: true, email: true, fullName: true } } },
    });
    await this.audit.record({
      actorUserId: user.id,
      organizationId: orgId,
      action: 'MEMBER_INVITED',
      entityType: 'OrganizationMember',
      entityId: member.id,
      metadata: { role: input.role },
    });
    return member;
  }

  // ─── Admin ───

  async adminList(status: OrganizationStatus | undefined, page: number, pageSize: number) {
    const where = status ? { status } : {};
    const [total, data] = await this.prisma.$transaction([
      this.prisma.organization.count({ where }),
      this.prisma.organization.findMany({
        where,
        skip: (page - 1) * pageSize,
        take: pageSize,
        orderBy: { createdAt: 'desc' },
        include: { _count: { select: { members: true, events: true } } },
      }),
    ]);
    return { data, meta: { page, pageSize, total, totalPages: Math.ceil(total / pageSize) } };
  }

  async review(admin: RequestUser, orgId: string, input: ReviewDecisionInput) {
    const org = await this.prisma.organization.findUnique({ where: { id: orgId } });
    if (!org)
      throw new AppException(ErrorCodes.NOT_FOUND, 'Organization not found.', HttpStatus.NOT_FOUND);

    const status =
      input.decision === 'APPROVE' ? OrganizationStatus.APPROVED : OrganizationStatus.REJECTED;
    const updated = await this.prisma.organization.update({
      where: { id: orgId },
      data: { status },
    });
    await this.audit.record({
      actorUserId: admin.id,
      organizationId: orgId,
      action: input.decision === 'APPROVE' ? 'ORGANIZATION_APPROVED' : 'ORGANIZATION_REJECTED',
      entityType: 'Organization',
      entityId: orgId,
      metadata: { note: input.note },
    });
    return updated;
  }
}
