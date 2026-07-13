import { Controller, Get } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { FEATURE_DEFAULTS, isFeatureEnabled, type FeatureFlag } from '@eticketsgo/shared-types';
import { Public } from '../common/decorators';

@ApiTags('public')
@Controller('capabilities')
export class CapabilitiesController {
  @Public()
  @Get()
  @ApiOperation({ summary: 'Resolved feature flags (capabilities) for the platform.' })
  get(): Record<string, boolean> {
    const flags = Object.keys(FEATURE_DEFAULTS) as FeatureFlag[];
    return Object.fromEntries(flags.map((flag) => [flag, isFeatureEnabled(flag)]));
  }
}
