import { Controller, Get } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { AdminPermission, Role } from '@eticketsgo/shared-types';
import { AiConfigService } from '../ai/ai-config.service';
import { AiUsageService } from '../ai/ai-usage.service';
import { PromptRegistry } from '../ai/prompts/prompt-registry';
import { RiskService } from './risk.service';
import { RequiresAdmin, CurrentUser, Roles, type RequestUser } from '../common/decorators';

/**
 * AI operations console (v2.0 WS9) + risk signals (WS8), admin-only. Reports provider
 * status, prompt versions, request volume, fallback rate, latency, cost estimate and
 * safety (redaction) events — never prompts, secrets or customer payloads.
 */
@ApiTags('admin')
@ApiBearerAuth()
@Roles(Role.ADMIN, Role.SUPER_ADMIN)
@RequiresAdmin(AdminPermission.PLATFORM_CONFIG)
@Controller('admin/ai')
export class AiAdminController {
  constructor(
    private readonly ai: AiConfigService,
    private readonly usage: AiUsageService,
    private readonly prompts: PromptRegistry,
    private readonly risk: RiskService,
  ) {}

  @Get('status')
  @ApiOperation({ summary: 'AI provider status, feature posture and prompt versions.' })
  async status() {
    return {
      ...this.ai.status(),
      prompts: this.prompts.versions(),
    };
  }

  @Get('usage')
  @ApiOperation({ summary: 'AI request volume, fallback rate, latency, cost and safety events.' })
  usageReport() {
    return this.usage.summary(30);
  }

  @Get('risk')
  @ApiOperation({ summary: 'Deterministic, advisory fraud/risk signals (audited).' })
  risks(@CurrentUser() admin: RequestUser) {
    return this.risk.signals(admin);
  }
}
