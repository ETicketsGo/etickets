import { Controller, Get } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { DiscoveryService } from './discovery.service';
import { Public } from '../common/decorators';

@ApiTags('public')
@Controller('public/discovery')
export class DiscoveryController {
  constructor(private readonly discovery: DiscoveryService) {}

  @Public()
  @Get()
  @ApiOperation({ summary: 'Unified experience discovery (movies + events + categories).' })
  get() {
    return this.discovery.get();
  }
}
