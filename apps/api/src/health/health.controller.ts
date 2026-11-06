import { Controller, Get, HttpStatus, Res } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Response } from 'express';
import { PrismaService } from '../prisma/prisma.service';
import { RedisService } from '../redis/redis.service';
import { Public } from '../common/decorators';

@ApiTags('health')
@Controller()
export class HealthController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
  ) {}

  @Public()
  @Get('health')
  @ApiOperation({ summary: 'Liveness probe.' })
  health() {
    return { status: 'ok', uptime: process.uptime(), build: buildInfo() };
  }

  @Public()
  @Get('ready')
  @ApiOperation({ summary: 'Readiness probe — checks database and Redis.' })
  async ready(@Res({ passthrough: true }) res: Response) {
    const [db, redis] = await Promise.all([this.checkDb(), this.redis.ping()]);
    const ready = db && redis;
    // Return 503 when a dependency is down so orchestrators/load balancers actually
    // deroute the pod; the body shape is unchanged for existing consumers.
    if (!ready) res.status(HttpStatus.SERVICE_UNAVAILABLE);
    return {
      status: ready ? 'ok' : 'degraded',
      checks: { database: db ? 'up' : 'down', redis: redis ? 'up' : 'down' },
    };
  }

  private async checkDb(): Promise<boolean> {
    try {
      await this.prisma.$queryRaw`SELECT 1`;
      return true;
    } catch {
      return false;
    }
  }
}

/**
 * Which build is answering: the commit, and whether the image was built once in CI and
 * promoted (`image`) or built by Railway from the repository (`railway`). A deploy is verified
 * by asking this, not by trusting a green tick: see docs/deployment/IMAGE-PROMOTION.md.
 * Public on purpose (customer-web's /api/health prints its build too); nothing here is secret.
 */
export function buildInfo(env: NodeJS.ProcessEnv = process.env) {
  const image = env.GIT_SHA?.trim();
  const railway = env.RAILWAY_GIT_COMMIT_SHA?.trim();
  return {
    sha: image || railway || null,
    version: env.BUILD_VERSION?.trim() || null,
    builtAt: env.BUILD_CREATED?.trim() || null,
    source: image ? ('image' as const) : railway ? ('railway' as const) : null,
  };
}
