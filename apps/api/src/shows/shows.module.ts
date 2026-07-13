import { Module } from '@nestjs/common';
import { ShowsController, PublicShowsController } from './shows.controller';
import { ShowsService } from './shows.service';

@Module({
  controllers: [ShowsController, PublicShowsController],
  providers: [ShowsService],
  exports: [ShowsService],
})
export class ShowsModule {}
