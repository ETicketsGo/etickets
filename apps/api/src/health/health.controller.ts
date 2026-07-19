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
    return { status: 'ok', uptime: process.uptime() };
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
