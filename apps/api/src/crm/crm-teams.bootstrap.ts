import { Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

/** The acquisition teams every installation starts with. */
export const DEFAULT_CRM_TEAMS = [
  { id: 'crmteam_in', key: 'IN', name: 'India', country: 'IN' },
  { id: 'crmteam_us', key: 'US', name: 'United States', country: 'US' },
] as const;

/**
 * Make sure the India and USA acquisition teams exist.
 *
 * The migration inserts them, but the destructive seed (LOCAL / CI / QA resets) truncates every
 * table, migration rows included, and a CRM with no team is one nobody can add a lead to. So
 * the API puts them back on boot: insert-if-missing by key, never an update, so a renamed or
 * deactivated team stays as somebody left it. Nobody is added to a team here.
 *
 * Never blocks boot: a failure is logged and the API starts without them.
 */
@Injectable()
export class CrmTeamsBootstrap implements OnModuleInit {
  private readonly logger = new Logger(CrmTeamsBootstrap.name);

  constructor(private readonly prisma: PrismaService) {}

  async onModuleInit(): Promise<void> {
    try {
      const res = await this.prisma.crmTeam.createMany({
        data: DEFAULT_CRM_TEAMS.map((t) => ({ ...t })),
        skipDuplicates: true,
      });
      if (res.count > 0) this.logger.log(`Created ${res.count} default acquisition team(s).`);
    } catch (err) {
      this.logger.warn(`Default acquisition teams not ensured: ${(err as Error).message}`);
    }
  }
}
