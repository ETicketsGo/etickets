import { Global, Module } from '@nestjs/common';
import { OrgAccessService } from './org-access.service';

@Global()
@Module({
  providers: [OrgAccessService],
  exports: [OrgAccessService],
})
export class TenancyModule {}
