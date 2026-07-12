import { Module } from '@nestjs/common';
import { TicketsController } from './tickets.controller';
import { TicketsService } from './tickets.service';
import { QrService } from './qr.service';

@Module({
  controllers: [TicketsController],
  providers: [TicketsService, QrService],
  exports: [QrService],
})
export class TicketsModule {}
