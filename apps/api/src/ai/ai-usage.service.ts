import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

export interface AiUsageRecord {
  feature: string;
  promptKey: string;
  promptVersion: string;
  provider: string;
  status: 'success' | 'fallback' | 'error' | 'disabled';
  latencyMs?: number;
  tokensIn?: number;
  tokensOut?: number;
  costMinor?: number;
  redactions?: number;
  organizationId?: string | null;
  actorUserId?: string | null;
  correlationId?: string | null;
}

/**
 * AI telemetry store (v2.0 WS9). Records one row per gateway call (never the prompt or
 * payload) and aggregates request volume, fallback rate, latency, cost and safety
 * events for the ops console. Recording never throws into the primary path.
 */
@Injectable()
export class AiUsageService {
  private readonly logger = new Logger('AiUsage');

  constructor(private readonly prisma: PrismaService) {}

  async record(rec: AiUsageRecord): Promise<void> {
    try {
      await this.prisma.aiUsage.create({
        data: {
          feature: rec.feature,
          promptKey: rec.promptKey,
          promptVersion: rec.promptVersion,
          provider: rec.provider,
          status: rec.status,
          latencyMs: rec.latencyMs ?? 0,
          tokensIn: rec.tokensIn ?? 0,
          tokensOut: rec.tokensOut ?? 0,
          costMinor: rec.costMinor ?? 0,
          redactions: rec.redactions ?? 0,
          organizationId: rec.organizationId ?? null,
          actorUserId: rec.actorUserId ?? null,
          correlationId: rec.correlationId ?? null,
        },
      });
    } catch (err) {
      this.logger.warn(`ai usage record failed: ${(err as Error).message}`);
    }
  }

  /** Aggregate telemetry over a window for the admin ops console. */
  async summary(sinceDays = 30) {
    const since = new Date(Date.now() - sinceDays * 86_400_000);
    const rows = await this.prisma.aiUsage.groupBy({
      by: ['status'],
      where: { createdAt: { gte: since } },
      _count: { _all: true },
      _sum: { costMinor: true, tokensIn: true, tokensOut: true, redactions: true },
      _avg: { latencyMs: true },
    });
    const total = rows.reduce((s, r) => s + r._count._all, 0);
    const byStatus = Object.fromEntries(rows.map((r) => [r.status, r._count._all]));
    const fallback = (byStatus.fallback ?? 0) + (byStatus.disabled ?? 0);
    const costMinor = rows.reduce((s, r) => s + (r._sum.costMinor ?? 0), 0);
    const redactions = rows.reduce((s, r) => s + (r._sum.redactions ?? 0), 0);
    const avgLatencyMs = rows.length
      ? Math.round(rows.reduce((s, r) => s + (r._avg.latencyMs ?? 0), 0) / rows.length)
      : 0;

    const byFeature = await this.prisma.aiUsage.groupBy({
      by: ['feature'],
      where: { createdAt: { gte: since } },
      _count: { _all: true },
    });

    return {
      windowDays: sinceDays,
      totalRequests: total,
      byStatus,
      errorCount: byStatus.error ?? 0,
      fallbackRate: total > 0 ? Math.round((fallback / total) * 100) : 0,
      avgLatencyMs,
      estimatedCostMinor: costMinor,
      safetyRedactions: redactions,
      byFeature: byFeature.map((f) => ({ feature: f.feature, count: f._count._all })),
    };
  }
}
