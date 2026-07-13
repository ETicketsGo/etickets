import { Module } from '@nestjs/common';
import { CinemasController, ScreensController } from './cinemas.controller';
import { CinemasService } from './cinemas.service';

@Module({
  controllers: [CinemasController, ScreensController],
  providers: [CinemasService],
  exports: [CinemasService],
})
export class CinemasModule {}
