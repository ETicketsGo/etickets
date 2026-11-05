import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { AddressInfo } from 'node:net';
import { ValidationPipe, type INestApplication } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import { JwtService } from '@nestjs/jwt';
import { AppModule } from '../../app.module';
import { AllExceptionsFilter } from '../../common/all-exceptions.filter';

/**
 * The acquisition CRM over real HTTP and Postgres, for the *.http.integration-postgres specs.
 *
 * Boots the whole AppModule (every guard as in production: JWT, roles, AdminPermissionGuard,
 * MFA - dormant on LOCAL as in the other staff specs), signs staff tokens directly, and creates
 * its OWN teams with a per-run suffix so parallel spec files and the seeded IN/US teams never
 * share a lead or a count. Everything it creates is removed in `close()`.
 */
function loadEnvValue(key: string): string | undefined {
  if (process.env[key]) return process.env[key];
  for (const p of ['../../../../../.env', '../../../../../../.env']) {
    try {
      const m = readFileSync(resolve(__dirname, p), 'utf8').match(new RegExp(`^${key}=(.*)$`, 'm'));
      if (m) return m[1].replace(/^["']|["']$/g, '').trim();
    } catch {
      /* try next */
    }
  }
  return undefined;
}

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { PrismaClient } = require('@prisma/client');
type Client = InstanceType<typeof PrismaClient>;

export interface Http {
  status: number;
  json: any;
  text: string;
  headers: Headers;
}

export class CrmHarness {
  db!: Client;
  app?: INestApplication;
  available = false;
  base = '';
  readonly suffix = `${Date.now().toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`;
  readonly ids: Record<string, string> = {};
  readonly tokens: Record<string, string> = {};
  readonly teams: Record<string, string> = {};
  readonly orgIds: string[] = [];
  private jwt!: JwtService;

  async start(): Promise<boolean> {
    const url = loadEnvValue('DATABASE_URL');
    if (!url) {
      console.warn('[integration-real-postgres] SKIPPED -- no DATABASE_URL');
      return false;
    }
    this.db = new PrismaClient({ datasources: { db: { url } } });
    try {
      await this.db.$queryRaw`SELECT 1`;
      // The CRM tables must exist (migration applied); otherwise skip like a missing DB.
      await this.db.$queryRaw`SELECT 1 FROM "CrmTeam" LIMIT 1`;
    } catch {
      console.warn('[integration-real-postgres] SKIPPED -- DB or CRM tables unavailable');
      return false;
    }
    this.available = true;
    process.env.DATABASE_URL = url;
    process.env.APP_ENV = process.env.APP_ENV ?? 'LOCAL';
    process.env.THROTTLE_LIMIT = '5000';
    process.env.AUTH_THROTTLE_LIMIT = '5000';
    const mod = await Test.createTestingModule({ imports: [AppModule] }).compile();
    this.app = mod.createNestApplication();
    this.app.setGlobalPrefix('api');
    this.app.useGlobalFilters(new AllExceptionsFilter());
    this.app.useGlobalPipes(new ValidationPipe({ transform: true }));
    await this.app.listen(0, '127.0.0.1');
    this.base = `http://127.0.0.1:${(this.app.getHttpServer().address() as AddressInfo).port}`;
    this.jwt = new JwtService({
      secret: this.app.get(ConfigService).getOrThrow<string>('JWT_ACCESS_SECRET'),
    });
    return true;
  }

  async user(key: string, roles: string[], grants: string[] = []) {
    const user = await this.db.user.create({
      data: {
        email: `${key}-${this.suffix}@test.invalid`,
        fullName: `${key} ${this.suffix}`,
        passwordHash: 'not-a-real-hash',
        roles,
      },
    });
    for (const permission of grants) {
      await this.db.adminGrant.create({ data: { userId: user.id, permission } });
    }
    this.ids[key] = user.id;
    this.tokens[key] = this.jwt.sign(
      { sub: user.id, email: user.email, name: key, roles },
      { expiresIn: '30m' },
    );
    return user.id as string;
  }

  async team(key: string, country: string) {
    const t = await this.db.crmTeam.create({
      data: {
        key: `T${this.suffix}${key}`.toUpperCase().slice(0, 32),
        name: `Test ${key}`,
        country,
      },
    });
    this.teams[key] = t.id;
    return t.id as string;
  }

  async member(teamKey: string, userKey: string, role: 'AGENT' | 'MANAGER') {
    await this.db.crmTeamMember.create({
      data: { teamId: this.teams[teamKey], userId: this.ids[userKey], role },
    });
  }

  async organization(key: string, status: string) {
    const org = await this.db.organization.create({
      data: {
        name: `Org ${key} ${this.suffix}`,
        slug: `org-${key}-${this.suffix}`.toLowerCase(),
        status,
        contactEmail: `${key}-${this.suffix}@org.test.invalid`,
      },
    });
    this.orgIds.push(org.id);
    return org.id as string;
  }

  /** A live event for an organization, so the first-event metric has something to derive. */
  async publishedEvent(orgId: string, publishedAt: Date) {
    const venue = await this.db.venue.create({
      data: { organizationId: orgId, name: `Venue ${this.suffix}`, city: 'Vijayawada' },
    });
    await this.db.event.create({
      data: {
        organizationId: orgId,
        venueId: venue.id,
        title: `Show ${this.suffix}`,
        slug: `show-${orgId}-${this.suffix}`.toLowerCase(),
        category: 'MUSIC',
        status: 'PUBLISHED',
        publishedAt,
      },
    });
  }

  async http(method: string, path: string, token?: string, body?: unknown): Promise<Http> {
    const res = await fetch(`${this.base}/api${path}`, {
      method,
      headers: {
        'content-type': 'application/json',
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    let json: any = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      json = null;
    }
    // Some deployments wrap payloads in { data }; the CRM never does, but tolerate it.
    return { status: res.status, json, text, headers: res.headers };
  }

  as(key: string) {
    const token = this.tokens[key];
    return {
      get: (p: string) => this.http('GET', p, token),
      post: (p: string, b?: unknown) => this.http('POST', p, token, b ?? {}),
      patch: (p: string, b?: unknown) => this.http('PATCH', p, token, b ?? {}),
      put: (p: string, b?: unknown) => this.http('PUT', p, token, b ?? {}),
      del: (p: string) => this.http('DELETE', p, token),
    };
  }

  async close() {
    if (this.db && this.available) {
      const userIds = Object.values(this.ids);
      const teamIds = Object.values(this.teams);
      const leads = await this.db.crmLead.findMany({
        where: { OR: [{ teamId: { in: teamIds } }, { createdByUserId: { in: userIds } }] },
        select: { id: true },
      });
      const leadIds = leads.map((l: { id: string }) => l.id);
      await this.db.crmFollowUp.deleteMany({ where: { leadId: { in: leadIds } } });
      await this.db.crmActivity.deleteMany({ where: { leadId: { in: leadIds } } });
      await this.db.crmLeadStageChange.deleteMany({ where: { leadId: { in: leadIds } } });
      await this.db.crmLead.deleteMany({ where: { id: { in: leadIds } } });
      await this.db.crmTeamMember.deleteMany({
        where: { OR: [{ teamId: { in: teamIds } }, { userId: { in: userIds } }] },
      });
      await this.db.crmTeam.deleteMany({ where: { id: { in: teamIds } } });
      await this.db.event.deleteMany({ where: { organizationId: { in: this.orgIds } } });
      await this.db.venue.deleteMany({ where: { organizationId: { in: this.orgIds } } });
      await this.db.auditLog.deleteMany({
        where: {
          OR: [
            { actorUserId: { in: userIds } },
            { entityId: { in: [...userIds, ...leadIds, ...teamIds] } },
          ],
        },
      });
      await this.db.organization.deleteMany({ where: { id: { in: this.orgIds } } });
      await this.db.adminGrant.deleteMany({ where: { userId: { in: userIds } } });
      await this.db.user.deleteMany({ where: { id: { in: userIds } } });
      await this.db.$disconnect();
    }
    if (this.app) await this.app.close();
  }
}

/** `it` that passes trivially when no database is reachable, like the other real-DB specs. */
export function realDb(h: CrmHarness) {
  return (name: string, fn: () => Promise<void>, timeout = 60_000) =>
    it(
      name,
      async () => {
        if (!h.available) return;
        await fn();
      },
      timeout,
    );
}
