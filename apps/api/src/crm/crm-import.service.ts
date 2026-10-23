import { HttpStatus, Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import {
  CRM_LEAD_SOURCES,
  CRM_LIMITS,
  CRM_PRIORITIES,
  CRM_SOURCE_LABELS,
} from '@eticketsgo/shared-types';
import { crmLeadFieldsSchema } from '@eticketsgo/validation';
import { PrismaService } from '../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import { AppException, ErrorCodes } from '../common/errors';
import type { RequestUser } from '../common/decorators';
import { CrmScopeService } from './crm-scope.service';
import { CsvParseError, IMPORT_COLUMNS, headerKey, parseCsv } from './crm-csv';
import { leadKeys, sharedKeys, type DuplicateField, type LeadKeys } from './crm-normalize';

export interface ImportRowResult {
  line: number;
  status: 'ok' | 'error' | 'duplicate';
  organizationName: string | null;
  errors?: string[];
  /** Which keys matched, and whether the match is another row of this same file. */
  matchedOn?: DuplicateField[];
  duplicateOf?: 'existing' | 'file';
  created?: boolean;
}

const split = (v: string) =>
  v
    .split(/[;|]/)
    .map((s) => s.trim())
    .filter(Boolean);

/** "Referral", "referral" and "REFERRAL" all mean REFERRAL. */
function sourceCode(v: string): string {
  const t = v.trim();
  if (!t) return 'OTHER';
  const upper = t.toUpperCase().replace(/[^A-Z]+/g, '_');
  if ((CRM_LEAD_SOURCES as readonly string[]).includes(upper)) return upper;
  const byLabel = Object.entries(CRM_SOURCE_LABELS).find(
    ([, label]) => label.toLowerCase() === t.toLowerCase(),
  );
  return byLabel ? byLabel[0] : t;
}

/**
 * Importing a spreadsheet of prospects.
 *
 * Two calls with the same file: a PREVIEW (commit=false) that writes nothing and says, row by
 * row, what would happen; then a COMMIT that validates everything again - never trusting the
 * preview - and creates the rows that pass, in one transaction. A row with an error is never
 * created; a row matching an existing lead (or an earlier row of the same file) is skipped
 * unless a manager chose to create duplicates.
 *
 * Bounded: CRM_LIMITS.importRowsMax rows and importCharsMax characters per request, refused
 * as a whole above that rather than half-imported.
 */
@Injectable()
export class CrmImportService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly scopes: CrmScopeService,
  ) {}

  async run(
    actor: RequestUser,
    input: { teamId: string; csv: string; commit: boolean; onDuplicate: 'skip' | 'create' },
  ) {
    const scope = await this.scopes.resolve(actor);
    const team = await this.prisma.crmTeam.findUnique({ where: { id: input.teamId } });
    if (!team || !team.active || !this.scopes.managesTeam(scope, team.id)) {
      throw this.scopes.managerOnly('import leads');
    }

    let parsed;
    try {
      parsed = parseCsv(input.csv);
    } catch (err) {
      if (err instanceof CsvParseError) {
        throw new AppException(ErrorCodes.VALIDATION_FAILED, err.message, HttpStatus.BAD_REQUEST);
      }
      throw err;
    }
    if (parsed.rows.length > CRM_LIMITS.importRowsMax) {
      throw new AppException(
        ErrorCodes.VALIDATION_FAILED,
        `The file has ${parsed.rows.length} rows. Import at most ${CRM_LIMITS.importRowsMax} at a time.`,
        HttpStatus.BAD_REQUEST,
      );
    }
    const columns = parsed.headers.map((h) => IMPORT_COLUMNS[headerKey(h)] ?? null);
    if (!columns.includes('organizationName')) {
      throw new AppException(
        ErrorCodes.VALIDATION_FAILED,
        'The file needs an "Organization name" column.',
        HttpStatus.BAD_REQUEST,
        { headers: parsed.headers },
      );
    }
    const ignoredColumns = parsed.headers.filter((_, i) => columns[i] === null);

    // Assignees by email, among this team's members who may hold work.
    const members = await this.prisma.crmTeamMember.findMany({
      where: { teamId: team.id, user: { status: 'ACTIVE' } },
      select: { userId: true, user: { select: { email: true, roles: true } } },
    });
    const assignable = new Map<string, string>();
    for (const m of members) {
      const held = await this.scopes.heldPermissions(m.userId, m.user.roles);
      if (held.has('CRM_AGENT')) assignable.set(m.user.email.toLowerCase(), m.userId);
    }

    type Candidate = {
      result: ImportRowResult;
      data?: Record<string, unknown>;
      keys?: LeadKeys;
      assignedToUserId?: string | null;
    };
    const candidates: Candidate[] = parsed.rows.map(({ line, cells }) => {
      const raw: Record<string, string> = {};
      columns.forEach((field, i) => {
        if (!field) return;
        const v = (cells[i] ?? '').trim();
        // Two columns for one field (LinkedIn + Social links): joined, not overwritten.
        raw[field] = raw[field] ? `${raw[field]};${v}` : v;
      });
      const errors: string[] = [];
      const country = (raw.country || team.country).toUpperCase();
      if (country !== team.country) {
        errors.push(`country: this team works ${team.country} prospects, the row says ${country}`);
      }
      const shaped = {
        organizationName: raw.organizationName ?? '',
        category: raw.category,
        website: raw.website,
        city: raw.city,
        state: raw.state,
        country: team.country,
        timezone: raw.timezone ? raw.timezone : undefined,
        contactName: raw.contactName,
        contactTitle: raw.contactTitle,
        email: raw.email,
        phone: raw.phone,
        socialLinks: raw.socialLinks ? split(raw.socialLinks) : undefined,
        source: sourceCode(raw.source ?? ''),
        priority: raw.priority
          ? (CRM_PRIORITIES as readonly string[]).includes(raw.priority.toUpperCase())
            ? raw.priority.toUpperCase()
            : raw.priority
          : undefined,
        notes: raw.notes,
        tags: raw.tags ? split(raw.tags.replace(/,/g, ';')) : undefined,
      };
      const v = crmLeadFieldsSchema.safeParse(shaped);
      if (!v.success) {
        for (const issue of v.error.issues)
          errors.push(`${issue.path.join('.') || 'row'}: ${issue.message}`);
      }
      let assignedToUserId: string | null = null;
      if (raw.assigneeEmail) {
        assignedToUserId = assignable.get(raw.assigneeEmail.toLowerCase()) ?? null;
        if (!assignedToUserId) errors.push('assignee: not an agent on this team');
      }
      const result: ImportRowResult = {
        line,
        status: errors.length ? 'error' : 'ok',
        organizationName: raw.organizationName || null,
        ...(errors.length ? { errors } : {}),
      };
      if (errors.length || !v.success) return { result };
      return { result, data: v.data, keys: leadKeys(v.data), assignedToUserId };
    });

    // Duplicates: against every existing lead (one query), then against earlier rows.
    const valid = candidates.filter((c) => c.keys);
    const pick = (k: keyof LeadKeys) => [
      ...new Set(valid.map((c) => c.keys![k]).filter((x): x is string => !!x)),
    ];
    const existing = valid.length
      ? await this.prisma.crmLead.findMany({
          where: {
            OR: [
              { nameKey: { in: pick('nameKey') } },
              { domainKey: { in: pick('domainKey') } },
              { emailKey: { in: pick('emailKey') } },
              { phoneKey: { in: pick('phoneKey') } },
            ],
          },
          select: { nameKey: true, domainKey: true, emailKey: true, phoneKey: true },
        })
      : [];
    const seen: LeadKeys[] = [];
    for (const c of valid) {
      const againstDb = existing.flatMap((e) => sharedKeys(c.keys!, e));
      const againstFile = seen.flatMap((s) => sharedKeys(c.keys!, s));
      if (againstDb.length || againstFile.length) {
        c.result.status = 'duplicate';
        c.result.matchedOn = [...new Set([...againstDb, ...againstFile])];
        c.result.duplicateOf = againstDb.length ? 'existing' : 'file';
      }
      seen.push(c.keys!);
    }

    const toCreate = valid.filter(
      (c) =>
        c.result.status === 'ok' ||
        (c.result.status === 'duplicate' && input.onDuplicate === 'create'),
    );
    const summary = {
      rows: candidates.length,
      ok: candidates.filter((c) => c.result.status === 'ok').length,
      duplicates: candidates.filter((c) => c.result.status === 'duplicate').length,
      errors: candidates.filter((c) => c.result.status === 'error').length,
      willCreate: toCreate.length,
      created: 0,
    };

    if (input.commit && toCreate.length > 0) {
      const now = new Date();
      const leads = toCreate.map((c) => ({
        id: randomUUID(),
        teamId: team.id,
        country: team.country,
        ...(c.data as object),
        ...c.keys!,
        assignedToUserId: c.assignedToUserId ?? null,
        createdByUserId: actor.id,
        stageChangedAt: now,
        createdAt: now,
      }));
      await this.prisma.$transaction(
        async (tx) => {
          await tx.crmLead.createMany({ data: leads as never });
          await tx.crmLeadStageChange.createMany({
            data: leads.map((l) => ({
              leadId: l.id,
              fromStage: null,
              toStage: 'IDENTIFIED' as const,
              changedByUserId: actor.id,
              note: 'Imported',
              createdAt: now,
            })),
          });
          await this.audit.recordInTransaction(tx, {
            actorUserId: actor.id,
            action: 'CRM_LEADS_IMPORTED',
            entityType: 'CrmTeam',
            entityId: team.id,
            metadata: {
              rows: summary.rows,
              created: leads.length,
              duplicatesCreated: toCreate.filter((c) => c.result.status === 'duplicate').length,
              skipped: summary.rows - leads.length,
            },
          });
        },
        { timeout: 60_000 },
      );
      for (const c of toCreate) c.result.created = true;
      summary.created = leads.length;
    }

    return {
      committed: input.commit,
      team: { id: team.id, key: team.key, country: team.country },
      ignoredColumns,
      summary,
      rows: candidates.map((c) => c.result),
    };
  }
}
