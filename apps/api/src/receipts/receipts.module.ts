import { Module } from '@nestjs/common';
import { OrganizationReceiptsController, ReceiptsController } from './receipts.controller';
import { ReceiptsService } from './receipts.service';
import { TenancyModule } from '../tenancy/tenancy.module';

@Module({
  imports: [TenancyModule],
  controllers: [ReceiptsController, OrganizationReceiptsController],
  providers: [ReceiptsService],
  exports: [ReceiptsService],
})
export class ReceiptsModule {}
