/**
 * Response shapes of the organizer acquisition API (`/admin/crm`), as the admin console reads
 * them. The vocabulary (stages, transitions, sources) is `@eticketsgo/shared-types` `crm.ts`.
 */
import type {
  CrmActivityOutcome,
  CrmActivityType,
  CrmDerivedActivation,
  CrmFollowUpStatus,
  CrmPriority,
  CrmStage,
  CrmTeamRole,
} from '@eticketsgo/shared-types';

export interface CrmPerson {
  id: string;
  fullName: string;
}

export interface CrmLead {
  id: string;
  teamId: string;
  team: { id: string; key: string; name: string; country: string };
  country: string;
  organizationName: string;
  category: string | null;
  website: string | null;
  city: string | null;
  state: string | null;
  timezone: string | null;
  contactName: string | null;
  contactTitle: string | null;
  email: string | null;
  phone: string | null;
  socialLinks: string[];
  source: string;
  priority: CrmPriority;
  notes: string | null;
  tags: string[];
  stage: CrmStage;
  stageChangedAt: string;
  lostReason: string | null;
  assignedToUserId: string | null;
  assignedTo: CrmPerson | null;
  organizationId: string | null;
  linkedAt: string | null;
  nextFollowUpAt: string | null;
  lastActivityAt: string | null;
  archivedAt: string | null;
  version: number;
  createdAt: string;
  updatedAt: string;
  derived: CrmDerivedActivation;
}

export interface CrmActivity {
  id: string;
  leadId: string;
  type: CrmActivityType;
  occurredAt: string;
  outcome: CrmActivityOutcome | null;
  notes: string | null;
  createdAt: string;
  responsible: CrmPerson;
  lead?: { id: string; organizationName: string; country: string; stage: CrmStage };
}

export interface CrmFollowUp {
  id: string;
  leadId: string;
  dueAt: string;
  title: string;
  notes: string | null;
  status: CrmFollowUpStatus;
  version: number;
  completedAt: string | null;
  completionNote: string | null;
  createdAt: string;
  owner: CrmPerson;
  lead?: { id: string; organizationName: string; country: string; stage: CrmStage; teamId: string };
}

export interface CrmStageChange {
  id: string;
  fromStage: CrmStage | null;
  toStage: CrmStage;
  note: string | null;
  createdAt: string;
  changedBy: CrmPerson | null;
}

export interface CrmLeadDetail extends CrmLead {
  stageHistory: CrmStageChange[];
  activities: CrmActivity[];
  followUps: CrmFollowUp[];
  allowedStages: CrmStage[];
  access: { manage: boolean; work: boolean };
}

export interface CrmDuplicateMatch {
  matchedOn: Array<'name' | 'domain' | 'email' | 'phone'>;
  visible: boolean;
  id?: string;
  organizationName?: string;
  stage?: CrmStage;
  assignedTo?: string | null;
  archived?: boolean;
}

export interface CrmMe {
  userId: string;
  isSuperAdmin: boolean;
  holdsManager: boolean;
  teams: Array<{
    id: string;
    key: string;
    name: string;
    country: string;
    active: boolean;
    manages: boolean;
  }>;
}

export interface CrmTeamMemberRow {
  userId: string;
  fullName: string;
  role: CrmTeamRole;
  email?: string;
  status?: string;
  since?: string;
  holdsAgent?: boolean;
  holdsManager?: boolean;
}

export interface CrmTeam {
  id: string;
  key: string;
  name: string;
  country: string;
  active: boolean;
  manages: boolean;
  members: CrmTeamMemberRow[];
}

export interface CrmRatio {
  numerator: number;
  denominator: number;
}

export interface CrmOverview {
  window: { from: string; to: string };
  totalProspects: number;
  newInWindow: number;
  currentStage: Record<CrmStage, number>;
  derived: { linked: CrmRatio; activated: CrmRatio; activatedWithFirstEvent: CrmRatio };
  followUps: { overdue: number; dueThisWeek: number };
  activitiesLoggedInWindow: number;
}

export interface CrmFunnel {
  cohort: number;
  cohortDefinition: string;
  stages: Array<{ stage: CrmStage; reached: number; ofCohort: CrmRatio }>;
  conversionByStage: Array<{ from: CrmStage; to: CrmStage; rate: CrmRatio }>;
  lost: CrmRatio;
  derived: { activated: CrmRatio; firstEvent: CrmRatio };
}

export interface CrmGroupRow {
  key: string | null;
  total: number;
  contacted: CrmRatio;
  interested: CrmRatio;
  demoCompleted: CrmRatio;
  onboarding: CrmRatio;
  lost: CrmRatio;
  linked: CrmRatio;
  activated: CrmRatio;
  firstEvent: CrmRatio;
}

export interface CrmEmployeeReport {
  window: { from: string; to: string };
  note: string;
  rows: Array<{
    userId: string | null;
    name: string;
    leads: CrmGroupRow | null;
    activitiesLogged: number;
    activitiesByType: Record<CrmActivityType, number>;
    stageMoves: number;
    overdueFollowUps: number;
  }>;
}

export interface CrmActivityReport {
  bucket: 'week' | 'month';
  window: { from: string; to: string };
  note: string;
  rows: Array<{ period: string; total: number } & Record<CrmActivityType, number>>;
}

export interface CrmAgingReport {
  definition: string;
  rows: Array<{
    stage: CrmStage;
    count: number;
    avgDays: number | null;
    maxDays: number | null;
    over30Days: CrmRatio;
  }>;
}

export interface CrmConversionReport {
  onboarding: { reached: number; linked: CrmRatio; approved: CrmRatio };
  firstEvent: {
    linked: number;
    approved: CrmRatio;
    withFirstPublishedEvent: CrmRatio;
    medianDaysFromLinkToFirstEvent: number | null;
  };
  manualStage: { activated: number; activatedButNotApprovedNow: number };
}

export interface CrmImportResult {
  committed: boolean;
  team: { id: string; key: string; country: string };
  ignoredColumns: string[];
  summary: {
    rows: number;
    ok: number;
    duplicates: number;
    errors: number;
    willCreate: number;
    created: number;
  };
  rows: Array<{
    line: number;
    status: 'ok' | 'error' | 'duplicate';
    organizationName: string | null;
    errors?: string[];
    matchedOn?: string[];
    duplicateOf?: 'existing' | 'file';
    created?: boolean;
  }>;
}

export interface CrmOrganizationMatch {
  id: string;
  name: string;
  slug: string;
  status: string;
  registeredCountry: string | null;
  createdAt: string;
  alreadyLinked: boolean;
}

export interface CrmReportFilters {
  from?: string;
  to?: string;
  country?: string;
  city?: string;
  assignee?: string;
  source?: string;
  stage?: string;
  bucket?: 'week' | 'month';
}

export interface CrmLeadFilters {
  page?: number;
  pageSize?: number;
  q?: string;
  stage?: string;
  country?: string;
  city?: string;
  teamId?: string;
  assignee?: string;
  source?: string;
  priority?: string;
  tag?: string;
  followUp?: 'overdue' | 'upcoming' | 'none';
  archived?: boolean;
  linked?: boolean;
  sort?: 'updated' | 'created' | 'name' | 'nextFollowUp' | 'stageAge';
}

export type CrmCsvReport =
  'funnel' | 'by-country' | 'by-source' | 'by-employee' | 'activity' | 'aging';
