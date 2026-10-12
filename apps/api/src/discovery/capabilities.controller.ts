import { Controller, Get } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { FEATURE_DEFAULTS, isFeatureEnabled, type FeatureFlag } from '@eticketsgo/shared-types';
import { Public } from '../common/decorators';

@ApiTags('public')
@Controller('capabilities')
export class CapabilitiesController {
  constructor(private readonly config: ConfigService) {}

  @Public()
  @Get()
  @ApiOperation({ summary: 'Resolved feature flags (capabilities) for the platform.' })
  get(): Record<string, boolean> {
    const flags = Object.keys(FEATURE_DEFAULTS) as FeatureFlag[];
    return {
      ...Object.fromEntries(flags.map((flag) => [flag, isFeatureEnabled(flag)])),
      // Read-only: false when SMS is declared off, so the storefront hides phone sign-in.
      phoneSignIn: this.config.get<string>('SMS_ENABLED') !== 'false',
    };
  }
}
