import { Controller, Get } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { Public } from '../../common/decorators';
import { BookingExecutionRouter } from './booking-execution-router.service';

/**
 * Read-only booking-orchestration health (ADR-042 §22). Public liveness-style probe that
 * reports the orchestration mode and durable-drift counts so operators can gate a rollout.
 * Never exposes ids or workflow internals; failure here does not affect other read/write
 * booking APIs.
 */
@ApiTags('health')
@Controller('health')
export class BookingOrchestrationHealthController {
  constructor(private readonly router: BookingExecutionRouter) {}

  @Public()
  @Get('booking-orchestration')
  @ApiOperation({ summary: 'Booking-orchestration mode + readiness signals.' })
  status() {
    return this.router.health();
  }
}
